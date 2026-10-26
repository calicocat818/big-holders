// 千張大戶集中度：每週從集保結算所 (TDCC) 下載股權分散表，存快照並計算 1 週、4 週變化。
// 不需要任何金鑰。Node.js 22 以上（內建 fetch）。
// 用法：node scripts/update.mjs            （下載最新資料）
//       node scripts/update.mjs 檔案.csv   （改讀本機 CSV，測試用）

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const SNAP = path.join(DATA, 'holders');
const TDCC_URL = 'https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5';
const KEEP_WEEKS = 12;
const THRESHOLD = 0.5;      // 判讀門檻：4 週變化 ±0.5 個百分點（沿用 EquiLens 規則）
const MARKET_MIN_PEOPLE = 1000;
const MARKET_TOP = 60;

const num = s => Number(String(s ?? '').replace(/[,\s"%]/g, ''));

// ---------- 1. 取得 CSV ----------
async function getCsv() {
  const local = process.argv[2];
  if (local) return readFile(local, 'utf8');
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(TDCC_URL, { headers: { 'User-Agent': 'Mozilla/5.0 tw-big-holders' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < 10000) throw new Error('內容太短，可能不是股權分散表');
      return text;
    } catch (e) {
      console.warn(`第 ${i} 次下載失敗：${e.message}`);
      if (i === 3) throw e;
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}

// ---------- 2. 解析 ----------
// 欄位：資料日期, 證券代號, 持股分級, 人數, 股數, 占集保庫存數比例%
// 分級 1–15 為持股級距（15 = 1,000,001 股以上，即千張大戶），16 = 差異數調整，17 = 合計
function parse(csv) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const stocks = {};
  let date = '';
  for (const line of lines) {
    const c = line.split(',').map(x => x.replace(/"/g, '').trim());
    if (c.length < 6 || !/^\d+$/.test(c[2])) continue;           // 跳過標題列
    const [d, id, lvRaw, people, shares, pct] = c;
    if (!/^\d{4}$/.test(id)) continue;                              // 只留四位數普通股
    const lv = Number(lvRaw);
    date ||= d.replace(/\D/g, '');
    const s = (stocks[id] ||= { big: 0, people: 0, shares: 0 });
    if (lv === 15) s.big = num(pct);
    if (lv === 17) { s.people = num(people); s.shares = num(shares); }
  }
  if (!date || Object.keys(stocks).length < 500) throw new Error('解析結果異常，CSV 格式可能變了');
  // 精簡存檔：[千張大戶%, 股東人數, 集保總股數]
  const out = {};
  for (const [id, s] of Object.entries(stocks)) out[id] = [s.big, s.people, s.shares];
  return { date, stocks: out };
}

// ---------- 3. 股票名稱（盡力而為，失敗就用 watchlist 裡的名稱） ----------
async function getNames(prev) {
  const names = { ...prev };
  const tries = [
    ['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', r => [r.Code, r.Name]],
    ['https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', r => [r.SecuritiesCompanyCode, r.CompanyName]],
  ];
  for (const [url, pick] of tries) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const r of await res.json()) {
        const [id, name] = pick(r);
        if (/^\d{4}$/.test(id || '') && name) names[id] = name.trim();
      }
    } catch (e) { console.warn(`名稱下載失敗（不影響計算）：${url} ${e.message}`); }
  }
  return names;
}

// ---------- 4. 計算 ----------
const toTime = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const daysBetween = (a, b) => (toTime(a) - toTime(b)) / 86400000;
const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

function pick(snaps, latest, minDays, maxDays) {
  return snaps.find(s => { const d = daysBetween(latest.date, s.date); return d >= minDays && d <= maxDays; }) || null;
}

function judge(d4, people4) {
  if (d4 == null) return '資料累積中';
  if (d4 >= THRESHOLD && people4 <= 0) return '籌碼集中';
  if (d4 <= -THRESHOLD && people4 >= 0) return '籌碼渙散';
  return '大致持平';
}

function row(id, latest, w1, w4, names, tag) {
  const now = latest.stocks[id];
  if (!now) return { id, name: names[id] || '', tag, missing: true };
  const a = w1?.stocks[id], b = w4?.stocks[id];
  const d1 = a ? now[0] - a[0] : null;
  const d4 = b ? now[0] - b[0] : null;
  const people4 = b && b[1] ? (now[1] - b[1]) / b[1] * 100 : null;
  return {
    id, name: names[id] || '', tag,
    big: round(now[0]), d1: round(d1), d4: round(d4),
    people: now[1], people4: round(people4, 1),
    verdict: judge(d4, people4 ?? 0),
  };
}

// ---------- 主程式 ----------
await mkdir(SNAP, { recursive: true });

const parsed = parse(await getCsv());
const snapFile = path.join(SNAP, `${parsed.date}.json`);
const old = existsSync(snapFile) ? JSON.parse(await readFile(snapFile, 'utf8')) : null;
if (old && !old.partial) console.log(`${parsed.date} 已存在，只重新計算`);
else { await writeFile(snapFile, JSON.stringify(parsed)); console.log(`新增快照 ${parsed.date}（${Object.keys(parsed.stocks).length} 檔）`); }

// 只保留最近 12 週
const files = (await readdir(SNAP)).filter(f => /^\d{8}\.json$/.test(f)).sort().reverse();
for (const f of files.slice(KEEP_WEEKS)) await unlink(path.join(SNAP, f));
const snaps = await Promise.all(files.slice(0, KEEP_WEEKS).map(async f => JSON.parse(await readFile(path.join(SNAP, f), 'utf8'))));
const latest = snaps[0];
const w1 = pick(snaps, latest, 5, 10);
const w4 = pick(snaps, latest, 25, 32);

const watch = JSON.parse(await readFile(path.join(ROOT, 'watchlist.json'), 'utf8'));
const namesFile = path.join(DATA, 'names.json');
let names = existsSync(namesFile) ? JSON.parse(await readFile(namesFile, 'utf8')) : {};
if (!process.argv[2]) { names = await getNames(names); await writeFile(namesFile, JSON.stringify(names)); }
for (const [id, n] of Object.entries(watch.stocks || {})) if (n && !names[id]) names[id] = n;

const sortBy4w = (x, y) => (y.d4 ?? -1e9) - (x.d4 ?? -1e9) || (y.d1 ?? -1e9) - (x.d1 ?? -1e9);
const mine = Object.keys(watch.stocks || {}).map(id => row(id, latest, w1, w4, names, '自選')).sort(sortBy4w);

// 全市場只用完整快照（補回來的歷史只有自選股，不能拿來排全市場）
const full = snaps.filter(s => !s.partial);
const fw1 = pick(full, latest, 5, 10), fw4 = pick(full, latest, 25, 32);
let market = { up: [], down: [] };
if (fw4 && !latest.partial) {
  const all = Object.keys(latest.stocks)
    .filter(id => latest.stocks[id][1] >= MARKET_MIN_PEOPLE)
    .map(id => row(id, latest, fw1, fw4, names, ''))
    .filter(r => r.d4 != null);
  market.up = all.filter(r => r.verdict === '籌碼集中').sort(sortBy4w).slice(0, MARKET_TOP);
  market.down = all.filter(r => r.verdict === '籌碼渙散').sort((x, y) => x.d4 - y.d4).slice(0, MARKET_TOP);
}

const out = {
  date: latest.date, w1: w1?.date || null, w4: w4?.date || null,
  weeks: snaps.length, fullWeeks: full.length, marketReady: !!fw4, updatedAt: new Date().toISOString(),
  mine, market,
};
await writeFile(path.join(DATA, 'latest.json'), JSON.stringify(out));
console.log(`完成：資料日 ${out.date}，1 週比較 ${out.w1 || '—'}，4 週比較 ${out.w4 || '—'}，自選 ${mine.length} 檔`);

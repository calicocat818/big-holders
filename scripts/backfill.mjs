// 補自選股的歷史股權分散資料：用集保「單一個股查詢」一檔一週慢慢查，
// 寫進 data/holders/<日期>.json（標記 partial，只含自選股，不會影響全市場排行）。
// 用法：node scripts/backfill.mjs [週數，預設 5]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SNAP = path.join(ROOT, 'data', 'holders');
const BASE = process.env.TDCC_QRY_URL || 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock';
const WEEKS = Number(process.argv[2]) || 5;
const DELAY = Number(process.env.DELAY_MS ?? 1500);   // 每次查詢間隔，避免造成集保負擔

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => Number(String(s ?? '').replace(/[,\s%]/g, ''));
const strip = s => s.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s|\u3000/g, '');

// ---- 簡易 cookie 保存（集保表單需要同一個 session） ----
let cookies = {};
function saveCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const HEAD = { 'User-Agent': 'Mozilla/5.0 (tw-big-holders weekly backfill)', 'Accept-Language': 'zh-TW' };

// 取得表單頁：隱藏欄位（含防偽 token）＋ 可查詢的日期清單
async function getForm() {
  const res = await fetch(BASE, { headers: { ...HEAD, Cookie: cookieHeader() } });
  if (!res.ok) throw new Error(`表單頁 HTTP ${res.status}`);
  saveCookies(res);
  const html = await res.text();
  const hidden = {};
  for (const m of html.matchAll(/<input[^>]*type=["']?hidden["']?[^>]*>/gi)) {
    const name = m[0].match(/name=["']([^"']+)["']/i)?.[1];
    const value = m[0].match(/value=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) hidden[name] = value;
  }
  const sel = html.match(/<select[^>]*name=["']scaDate["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] || '';
  const dates = [...sel.matchAll(/value=["'](\d{8})["']/g)].map(m => m[1]);
  if (!dates.length) throw new Error('找不到日期選單，集保頁面格式可能變了');
  return { hidden, dates };
}

// 查一檔一週，回傳 [千張大戶%, 股東人數, 總股數]
async function query(stockNo, date) {
  const { hidden } = await getForm();                 // 每次重新取 token
  const body = new URLSearchParams({
    ...hidden,
    method: 'submit', firDate: hidden.firDate || date,
    scaDate: date, sqlMethod: 'StockNo', stockNo, stockName: '',
  });
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { ...HEAD, Cookie: cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE },
    body,
  });
  if (!res.ok) throw new Error(`查詢 HTTP ${res.status}`);
  saveCookies(res);
  const html = await res.text();
  let big = null, people = null, shares = null;
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => strip(m[1]));
    if (cells.length < 4) continue;
    const n = cells.length;
    if (cells[0] === '15') big = num(cells[n - 1]);
    if (cells.some(c => c.includes('合計'))) { people = num(cells[n - 3]); shares = num(cells[n - 2]); }
  }
  if (big == null || people == null) return null;      // 該週無資料（例如當時未上市）
  return [big, people, shares];
}

// ---------- 主程式 ----------
await mkdir(SNAP, { recursive: true });
const watch = Object.keys(JSON.parse(await readFile(path.join(ROOT, 'watchlist.json'), 'utf8')).stocks || {});
const { dates } = await getForm();
const targets = dates.slice(0, WEEKS + 1);              // 最新一週＋往前 N 週
console.log(`自選 ${watch.length} 檔，補 ${targets.join(', ')}`);

let ok = 0, miss = 0, fail = 0;
for (const date of targets) {
  const file = path.join(SNAP, `${date}.json`);
  const snap = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : { date, partial: true, stocks: {} };
  let changed = false;
  for (const id of watch) {
    if (snap.stocks[id]) continue;                      // 已經有了就跳過
    try {
      const r = await query(id, date);
      if (r) { snap.stocks[id] = r; changed = true; ok++; } else miss++;
    } catch (e) { fail++; console.warn(`${date} ${id} 失敗：${e.message}`); }
    await sleep(DELAY);
  }
  if (changed) await writeFile(file, JSON.stringify(snap));
  console.log(`${date}：目前 ${Object.keys(snap.stocks).length} 檔${snap.partial ? '（僅自選）' : ''}`);
}
console.log(`完成：成功 ${ok}、無資料 ${miss}、失敗 ${fail}`);
if (ok === 0 && fail > 0) process.exit(1);

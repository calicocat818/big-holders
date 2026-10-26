// 週線突破第一根：收盤由下往上站上 26 週均線（上週還在均線下），
// 且本週量能放大、排除冷門股。資料來源：證交所＋櫃買中心每日全市場收盤行情（免金鑰）。
// 每天收盤後執行；第一次會自動往回補約 27 週資料（需要 5～10 分鐘）。

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const DAILY = path.join(DATA, 'daily');
const NODATA_FILE = path.join(DAILY, '_closed.json');

// ---- 條件（要調整就改這裡） ----
const MA_WEEKS = 26;          // 週均線週數
const VOL_WEEKS = 5;          // 量能比較：前幾週
const VOL_RATIO = 1.5;        // 本週日均量 ≥ 前 5 週日均量的幾倍
const MIN_VALUE = 50_000_000; // 日均成交值下限（元）
const DELAY = Number(process.env.DELAY_MS ?? 3500); // 證交所建議每次間隔數秒

const TWSE = process.env.TWSE_URL || 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX';
const TPEX = process.env.TPEX_URL || 'https://www.tpex.org.tw/www/zh-tw/afterTrading/otc';
const HEAD = { 'User-Agent': 'Mozilla/5.0 (tw-big-holders daily scan)', Accept: 'application/json,*/*' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = Number(String(s ?? '').replace(/<[^>]*>|,|\s/g, '')); return Number.isFinite(v) ? v : null; };
const isStock = id => /^[1-9]\d{3}$/.test(id);

// ---- 日期工具（一律用台灣時間） ----
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const fromYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const todayTW = () => { const t = new Date(Date.now() + 8 * 3600000); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())); };
const monday = d => addDays(d, -((d.getUTCDay() + 6) % 7));
const rocToYmd = s => { const m = String(s || '').match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/); if (!m) return ''; const y = +m[1] < 1000 ? +m[1] + 1911 : +m[1]; return `${y}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`; };

// ---- 抓單日全市場 ----
async function getJson(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: HEAD });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      if (i === 3) throw e;
      await sleep(DELAY * i * 2);
    }
  }
}

function pickTable(json, needs) {
  const tables = [...(json.tables || [])];
  for (let i = 1; i <= 20; i++) if (json[`fields${i}`]) tables.push({ fields: json[`fields${i}`], data: json[`data${i}`] });
  if (json.fields && json.data) tables.push({ fields: json.fields, data: json.data, date: json.date });
  return tables.find(t => t.fields && needs.every(k => t.fields.some(f => f.includes(k))));
}

function rowsFrom(table, names, market) {
  const f = k => table.fields.findIndex(x => x.includes(k));
  const iId = f('代號'), iName = f('名稱'), iClose = f('收盤'), iVol = f('成交股數'), iVal = f('成交金額');
  const out = {};
  for (const r of table.data || []) {
    const id = String(r[iId]).trim();
    if (!isStock(id)) continue;
    const close = num(r[iClose]);
    out[id] = [close && close > 0 ? close : null, num(r[iVol]) || 0, num(r[iVal]) || 0];
    if (iName >= 0) names[id] = String(r[iName]).trim();
    out[id].push(market);
  }
  return out;
}

async function fetchTwse(date, names) {
  const j = await getJson(`${TWSE}?date=${date}&type=ALLBUT0999&response=json`);
  if (j.stat && j.stat !== 'OK') return null;                       // 休市
  if (j.date && j.date !== date) return null;
  const t = pickTable(j, ['證券代號', '收盤價']);
  return t?.data?.length ? rowsFrom(t, names, '上市') : null;
}

async function fetchTpex(date, names) {
  const slash = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
  for (const d of [date, slash]) {
    const j = await getJson(`${TPEX}?date=${encodeURIComponent(d)}&type=EW&response=json`);
    const t = pickTable(j, ['代號', '收盤']);
    const got = rocToYmd(t?.date || j.date || '');
    if (t?.data?.length && (!got || got === date)) return rowsFrom(t, names, '上櫃');
    if (got && got !== date && d === slash) return null;
    await sleep(DELAY);
  }
  return null;
}

// 回傳 true = 有交易資料並已存檔，false = 休市（或今天資料還沒公布）
async function ensureDay(date, names, closed) {
  const file = path.join(DAILY, `${date}.json`);
  if (existsSync(file)) {
    const old = JSON.parse(await readFile(file, 'utf8'));
    if (!old._partial) return true;                    // 上次缺櫃買資料就重抓
  }
  if (closed.has(date)) return false;
  const twse = await fetchTwse(date, names); await sleep(DELAY);
  if (!twse) {
    if (date < ymd(todayTW())) closed.add(date);       // 今天可能只是還沒公布，不記成休市
    console.log(`${date} 無資料（休市或尚未公布）`);
    return false;
  }
  const tpex = await fetchTpex(date, names); await sleep(DELAY);
  if (!tpex) console.warn(`${date} 櫃買資料取得失敗，這天先只有上市股，下次會重抓`);
  await writeFile(file, JSON.stringify({ ...twse, ...(tpex || { _partial: 1 }) }));
  console.log(`${date} 上市 ${Object.keys(twse).length}、上櫃 ${tpex ? Object.keys(tpex).length : 0}`);
  return true;
}

// ---------- 主程式 ----------
await mkdir(DAILY, { recursive: true });
const namesFile = path.join(DATA, 'names.json');
const names = existsSync(namesFile) ? JSON.parse(await readFile(namesFile, 'utf8')) : {};
const closed = new Set(existsSync(NODATA_FILE) ? JSON.parse(await readFile(NODATA_FILE, 'utf8')) : []);

const today = todayTW();
const thisMon = monday(today);
const keep = new Set();

// 依序往回：前 6 個「有交易的週」每天都要（算量能）；更早的週只要最後一個交易日（算週收盤）
// 遇到整週休市（例如春節）就再往前多拿一週，湊滿 27 個交易週
const weeks = [];   // [{mon, days:[date...]}]，index 0 = 最新一週
for (let w = 0; weeks.length < MA_WEEKS + 1 && w <= MA_WEEKS + 6; w++) {
  const mon = addDays(thisMon, -7 * w);
  const days = [];
  if (weeks.length <= VOL_WEEKS) {
    for (let d = 0; d < 5; d++) {
      const day = addDays(mon, d);
      if (day > today) break;
      const s = ymd(day);
      if (await ensureDay(s, names, closed)) { days.push(s); keep.add(s); }
    }
  } else {
    for (let d = 4; d >= 0; d--) {                  // 週五往回找
      const s = ymd(addDays(mon, d));
      if (await ensureDay(s, names, closed)) { days.push(s); keep.add(s); break; }
    }
  }
  if (days.length) weeks.push({ mon: ymd(mon), days });
}

// 刪掉用不到的舊檔
for (const f of await readdir(DAILY)) {
  const m = f.match(/^(\d{8})\.json$/);
  if (m && !keep.has(m[1])) await unlink(path.join(DAILY, f));
}
await writeFile(NODATA_FILE, JSON.stringify([...closed].filter(d => d >= ymd(addDays(thisMon, -7 * (MA_WEEKS + 2)))).sort()));
await writeFile(namesFile, JSON.stringify(names));

// 載入資料
const day = {};
for (const d of keep) day[d] = JSON.parse(await readFile(path.join(DAILY, `${d}.json`), 'utf8'));
const W = weeks;
const latestDate = W[0]?.days.at(-1);
if (!latestDate || W.length < MA_WEEKS + 1) {
  console.log(`週資料不足（${W.length} 週），先不計算`);
  process.exit(0);
}

const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
const list = [];
const ids = Object.keys(day[latestDate]).filter(isStock);
for (const id of ids) {
  // 週收盤 = 該週最後一個有成交的收盤價
  const closes = W.map(w => { for (let i = w.days.length - 1; i >= 0; i--) { const v = day[w.days[i]][id]; if (v?.[0]) return v[0]; } return null; });
  if (closes.slice(0, MA_WEEKS + 1).some(c => c == null)) continue;   // 新上市或停牌，資料不足
  const maNow = avg(closes.slice(0, MA_WEEKS));
  const maPrev = avg(closes.slice(1, MA_WEEKS + 1));
  if (!(closes[0] > maNow && closes[1] <= maPrev)) continue;

  // 量能：日均量
  const dailyVol = w => { const v = w.days.map(d => day[d][id]?.[1] || 0); return { sum: v.reduce((s, x) => s + x, 0), n: v.length }; };
  const now = dailyVol(W[0]);
  const prev = W.slice(1, VOL_WEEKS + 1).map(dailyVol);
  const prevAvg = prev.reduce((s, x) => s + x.sum, 0) / Math.max(1, prev.reduce((s, x) => s + x.n, 0));
  const nowAvg = now.sum / Math.max(1, now.n);
  const ratio = prevAvg > 0 ? nowAvg / prevAvg : null;
  const vals = W.slice(0, VOL_WEEKS + 1).flatMap(w => w.days.map(d => day[d][id]?.[2] || 0));
  const valueAvg = avg(vals);
  if (!(ratio >= VOL_RATIO) || valueAvg < MIN_VALUE) continue;

  list.push({
    id, name: names[id] || '', market: day[latestDate][id][3] || '',
    close: closes[0], ma: Math.round(maNow * 100) / 100,
    above: Math.round((closes[0] / maNow - 1) * 1000) / 10,              // 高於均線 %
    week: Math.round((closes[0] / closes[1] - 1) * 1000) / 10,           // 本週漲跌 %
    vol: Math.round(ratio * 10) / 10,                                     // 量比
    value: Math.round(valueAvg / 1e6) / 100,                              // 日均成交值（億）
  });
}
list.sort((a, b) => b.vol - a.vol);

const out = {
  date: latestDate, weekStart: W[0].mon, days: W[0].days.length,
  rule: { maWeeks: MA_WEEKS, volWeeks: VOL_WEEKS, volRatio: VOL_RATIO, minValue: MIN_VALUE },
  scanned: ids.length, list, updatedAt: new Date().toISOString(),
};
await writeFile(path.join(DATA, 'breakout.json'), JSON.stringify(out));
console.log(`完成：${latestDate}（本週第 ${out.days} 個交易日），掃描 ${ids.length} 檔，符合 ${list.length} 檔`);

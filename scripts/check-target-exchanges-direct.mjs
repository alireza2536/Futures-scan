import { calculateLatestIndicators, calculateEMA } from "./indicators.mjs";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";

const MIN_HISTORY = 1201;
const TARGETS = [
  { tf: "15m", ms: 900000, htx: "15min", bitmart: 15, crypto: "15m" },
  { tf: "4h", ms: 14400000, htx: "4hour", bitmart: 240, crypto: "4h" },
  { tf: "1d", ms: 86400000, htx: "1day", bitmart: 1440, crypto: "1d" }
];

async function getJson(url, options = {}) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Futures-scan/0.3" }, ...options });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}; non-JSON response: ${text.slice(0, 160)}`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 220)}`);
  return body;
}
function validBar(b) {
  return b && Number.isFinite(b.timestamp) && [b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) &&
    b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close);
}
function normalizeBars(rows, map) {
  const byTime = new Map();
  for (const row of rows ?? []) {
    const b = map(row);
    if (validBar(b)) byTime.set(b.timestamp, b);
  }
  return [...byTime.values()].sort((a,b) => a.timestamp-b.timestamp);
}
function reportHistory(exchange, tf, bars, required = MIN_HISTORY) {
  const duration = TARGETS.find(x => x.tf === tf).ms;
  const latest = bars.at(-1);
  if (bars.length < (tf === "1d" ? 50 : required)) throw new Error(`only ${bars.length} valid candles; need ${tf === "1d" ? 50 : required}`);
  const expectedFloor = Math.floor(Date.now()/duration)*duration-duration;
  if (!latest || latest.timestamp < expectedFloor) throw new Error(`stale latest candle ${latest ? new Date(latest.timestamp).toISOString() : "missing"}`);
  if (tf === "4h") {
    const closed = keepClosedFourHourCandles(bars);
    if (closed.length < MIN_HISTORY) throw new Error(`only ${closed.length} closed 4h candles; need ${MIN_HISTORY}`);
    const v = calculateLatestIndicators(closed, { emaLength: 500, cciLength: 1200 });
    console.log(JSON.stringify({ exchange, test: "4h indicators", status: "PASS", candles: bars.length, closedCandles: closed.length, candleTime: new Date(v.timestamp).toISOString(), close: v.close, ema500: v.ema, cci1200: v.cci, longConditionMet: isLongSetup({ close: v.close, ema500: v.ema, cci1200: v.cci }) }));
  } else if (tf === "1d") {
    const closes = bars.map(b=>b.close);
    console.log(JSON.stringify({ exchange, test: "daily indicators", status: "PASS", candles: bars.length, close: closes.at(-1), ema20: calculateEMA(closes,20).at(-1), ema50: calculateEMA(closes,50).at(-1) }));
  }
  console.log(JSON.stringify({ exchange, test: `${tf} history`, status: "PASS", candles: bars.length, latest: new Date(latest.timestamp).toISOString() }));
}
function htxMap(r) {
  return { timestamp: Number(r.id)*1000, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.vol ?? r.amount) };
}
function bitmartMap(r) {
  return { timestamp: Number(r.timestamp ?? r.ts)*1000, open: Number(r.open_price ?? r.o), high: Number(r.high_price ?? r.h), low: Number(r.low_price ?? r.l), close: Number(r.close_price ?? r.c), volume: Number(r.volume ?? r.v) };
}
function cryptoMap(r) {
  return { timestamp: Number(r.t ?? r.timestamp), open: Number(r.o ?? r.open), high: Number(r.h ?? r.high), low: Number(r.l ?? r.low), close: Number(r.c ?? r.close), volume: Number(r.v ?? r.volume ?? r.q) };
}

async function testHtx() {
  const exchange = "HTX";
  console.log(JSON.stringify({ exchange, test: "API", status: "START" }));
  const contract = await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info");
  const contracts = contract.data ?? [];
  const btc = contracts.find(x => /BTC-USDT/i.test(x.contract_code ?? "") && (x.contract_status === 1 || x.contract_status === undefined));
  if (!btc) throw new Error(`HTX no active BTC-USDT linear contract; contracts=${contracts.length}`);
  console.log(JSON.stringify({ exchange, test: "BTC USDT perpetual", status: "PASS", symbol: btc.contract_code }));
  for (const t of TARGETS) {
    const url = new URL("https://api.hbdm.com/linear-swap-ex/market/history/kline");
    url.search = new URLSearchParams({ contract_code: btc.contract_code, period: t.htx, size: String(t.tf === "1d" ? 60 : 2000) }).toString();
    const payload = await getJson(url);
    if (payload.status !== "ok" || !Array.isArray(payload.data)) throw new Error(`HTX ${t.tf} kline API: ${payload.status ?? "bad response"} ${payload.err_msg ?? ""}`);
    const bars = normalizeBars(payload.data, htxMap).slice(- (t.tf === "1d" ? 60 : 2000));
    reportHistory(exchange, t.tf, bars);
  }
}
async function testBitmart() {
  const exchange = "BitMart";
  console.log(JSON.stringify({ exchange, test: "API", status: "START" }));
  let detail; let detailError;\n  for (const base of ["https://api-cloud-v2.bitmart.com", "https://api-cloud.bitmart.com"]) { try { detail = await getJson(`${base}/contract/public/details`); break; } catch (e) { detailError = e; } }\n  if (!detail) throw new Error(`BitMart contract endpoint unreachable: ${detailError?.message ?? "unknown error"}`);
  const contracts = detail.data?.symbols ?? detail.data?.contracts ?? [];
  const btc = contracts.find(x => /BTCUSDT/i.test(x.symbol ?? "") && (!x.status || String(x.status).toLowerCase() === "trading" || String(x.status) === "1"));
  if (!btc) throw new Error(`BitMart no BTCUSDT contract in details; contracts=${contracts.length}; keys=${Object.keys(detail.data ?? {}).join(",")}`);
  const symbol = btc.symbol;
  console.log(JSON.stringify({ exchange, test: "BTC USDT perpetual", status: "PASS", symbol }));
  for (const t of TARGETS) {
    const end = Math.floor(Date.now()/1000);
    const start = end - Math.ceil(t.ms/1000)*(t.tf === "1d" ? 60 : 2000);
    const collected = new Map();
    // BitMart documents at most 500 candles per request; page the time window explicitly.
    const pageSeconds = Math.ceil(t.ms/1000)*450;
    let cursor = start;
    for (let page=0; page<8 && cursor<end; page++) {
      const to = Math.min(end, cursor+pageSeconds);
      const url = new URL("https://api-cloud-v2.bitmart.com/contract/public/kline");
      url.search = new URLSearchParams({ symbol, step: String(t.bitmart), start_time: String(cursor), end_time: String(to) }).toString();
      const payload = await getJson(url);
      if (Number(payload.code) !== 1000 || !Array.isArray(payload.data?.klines ?? payload.data)) throw new Error(`BitMart ${t.tf} kline response invalid: ${JSON.stringify(payload).slice(0,180)}`);
      const rows = payload.data.klines ?? payload.data;
      for (const r of rows) { const b = bitmartMap(r); if (validBar(b)) collected.set(b.timestamp,b); }
      cursor = to + Math.ceil(t.ms/1000);
    }
    const bars = [...collected.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-(t.tf === "1d" ? 60 : 2000));
    reportHistory(exchange, t.tf, bars);
  }
}
async function testCryptoCom() {
  const exchange = "Crypto.com";
  console.log(JSON.stringify({ exchange, test: "API", status: "START" }));
  let payload; let apiError;\n  for (const params of [{ instrument_type: "PERPETUAL" }, {}]) { try { payload = await getJson("https://deriv-api.crypto.com/v1/public/get-instruments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, method: "public/get-instruments", params }) }); if (payload.code === 0) break; apiError = new Error(JSON.stringify(payload)); } catch (e) { apiError = e; } }\n  if (!payload || payload.code !== 0) throw new Error(`Crypto.com derivatives instrument endpoint failed: ${apiError?.message ?? "unknown error"}`);
  const instruments = payload.result?.data ?? payload.result?.instruments ?? [];
  const btcContracts = instruments.filter(x => /BTC/i.test(x.instrument_name ?? "") && /PERPETUAL|PERP/i.test(`${x.instrument_type ?? ""} ${x.instrument_name ?? ""}`));
  const btcUsdt = btcContracts.find(x => /USDT/i.test(x.instrument_name ?? "") && !/USDC/i.test(x.instrument_name ?? ""));
  console.log(JSON.stringify({ exchange, test: "contract list", status: "PASS", instruments: instruments.length, btcDerivativeExamples: btcContracts.slice(0,8).map(x=>x.instrument_name), btcUsdtPerpetualFound: Boolean(btcUsdt) }));
  if (!btcUsdt) throw new Error(`No BTC/USDT perpetual in Crypto.com derivatives API; BTC derivatives found: ${btcContracts.map(x=>x.instrument_name).join(", ") || "none"}`);
  for (const t of TARGETS) {
    const candle = await getJson("https://deriv-api.crypto.com/v1/public/get-candlestick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 2, method: "public/get-candlestick", params: { instrument_name: btcUsdt.instrument_name, timeframe: t.crypto, count: t.tf === "1d" ? 60 : 2000 } }) });
    const rows = candle.result?.data ?? candle.result?.candlesticks ?? [];
    const bars = normalizeBars(rows, cryptoMap).slice(-(t.tf === "1d" ? 60 : 2000));
    reportHistory(exchange, t.tf, bars);
  }
}
const outcomes = [];
for (const [name, fn] of [["Crypto.com",testCryptoCom],["HTX",testHtx],["BitMart",testBitmart]]) {
  try { await fn(); outcomes.push({ exchange: name, status: "TESTED" }); }
  catch (error) { console.error(JSON.stringify({ exchange: name, status: "BLOCKED", error: error.message })); outcomes.push({ exchange: name, status: "BLOCKED", error: error.message }); }
}
console.log("DIRECT_API_FINAL " + JSON.stringify(outcomes));
if (outcomes.some(x => x.status === "BLOCKED")) process.exitCode = 1;

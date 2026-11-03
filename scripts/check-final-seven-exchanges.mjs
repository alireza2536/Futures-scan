import ccxt from "ccxt";
import { writeFile } from "node:fs/promises";
import { calculateCCI, calculateEMA, calculateLatestIndicators } from "./indicators.mjs";

const EXCHANGES = [
  { label: "MEXC", id: "mexc" },
  { label: "BingX", id: "bingx" },
  { label: "OKX", id: "okx" },
  { label: "WEEX", id: "weex" },
  { label: "HTX", id: "htx" },
  { label: "KuCoin", id: "kucoinfutures" },
  { label: "XT", id: "xt" }
];
const MS = { "15m": 900000, "1h": 3600000, "2h": 7200000, "4h": 14400000, "1d": 86400000 };
const NEED = { "15m": 1200, "1h": 5000, "2h": 1200, "4h": 1200, "1d": 50 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validRow(row) {
  return Array.isArray(row) && row.length >= 6 &&
    [0,1,2,3,4,5].every(i => Number.isFinite(Number(row[i]))) &&
    Number(row[1]) > 0 && Number(row[2]) >= Math.max(Number(row[1]), Number(row[3]), Number(row[4])) &&
    Number(row[3]) <= Math.min(Number(row[1]), Number(row[4])) && Number(row[5]) >= 0;
}
function toBars(rows, timeframe) {
  const duration = MS[timeframe];
  const now = Date.now();
  const byTime = new Map();
  for (const row of rows) {
    if (!validRow(row)) continue;
    const timestamp = Number(row[0]);
    if (timestamp + duration > now) continue;
    byTime.set(timestamp, {
      timestamp, open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])
    });
  }
  return [...byTime.values()].sort((a,b) => a.timestamp-b.timestamp);
}
async function fetchHistory(exchange, symbol, timeframe, required) {
  if (!exchange.timeframes?.[timeframe]) throw new Error(`Timeframe ${timeframe} not supported by CCXT adapter`);
  const duration = MS[timeframe];
  const collected = new Map();
  let since = Date.now() - duration * (required + 8);
  let pages = 0;
  while (collected.size < required && pages < 70) {
    const before = collected.size;
    const remaining = required - collected.size;
    const limit = Math.min(1000, Math.max(100, remaining + 10));
    const rows = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const bar of toBars(rows, timeframe)) collected.set(bar.timestamp, bar);
    const timestamps = rows.map(row => Number(row?.[0])).filter(Number.isFinite);
    const newest = timestamps.length ? Math.max(...timestamps) : NaN;
    if (!Number.isFinite(newest) || newest < since || collected.size === before) break;
    since = newest + duration;
    pages += 1;
    await sleep(Math.max(100, Number(exchange.rateLimit) || 100));
  }
  const bars = [...collected.values()].sort((a,b) => a.timestamp-b.timestamp).slice(-required);
  if (bars.length < required) throw new Error(`Only ${bars.length}/${required} closed valid ${timeframe} candles after ${pages} pages`);
  const latest = bars.at(-1);
  const freshnessFloor = Math.floor(Date.now()/duration)*duration - duration*2;
  if (latest.timestamp < freshnessFloor) throw new Error(`Latest ${timeframe} candle is stale: ${new Date(latest.timestamp).toISOString()}`);
  return { bars, pages };
}
function aggregate1hTo2h(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const bucket = Math.floor(bar.timestamp/MS["2h"])*MS["2h"];
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(bar);
  }
  const output = [];
  for (const [timestamp, group] of [...groups.entries()].sort((a,b)=>a[0]-b[0])) {
    group.sort((a,b)=>a.timestamp-b.timestamp);
    if (group.length !== 2 || group[0].timestamp !== timestamp || group[1].timestamp !== timestamp + MS["1h"]) continue;
    output.push({
      timestamp, open: group[0].open,
      high: Math.max(...group.map(x=>x.high)),
      low: Math.min(...group.map(x=>x.low)),
      close: group[1].close,
      volume: group.reduce((sum,x)=>sum+x.volume,0)
    });
  }
  return output;
}
async function checkExchange(config) {
  const result = { exchange: config.label, ccxt: config.id, status: "FAIL", checks: [], history: {} };
  if (!ccxt.exchanges.includes(config.id)) {
    result.checks.push({ test: "CCXT adapter", status: "FAIL", detail: "Adapter missing from installed CCXT" });
    return result;
  }
  const exchange = new ccxt[config.id]({
    enableRateLimit: true, timeout: 30000, options: { defaultType: "swap" }
  });
  try {
    const markets = await exchange.loadMarkets();
    const contracts = Object.values(markets).filter(m =>
      m && m.swap === true && m.active !== false && m.quote === "USDT" && m.settle === "USDT"
    );
    result.activeUsdtPerpetuals = contracts.length;
    result.checks.push({
      test: "Public markets / active USDT-settled perpetuals",
      status: contracts.length > 0 ? "PASS" : "FAIL",
      detail: `${Object.keys(markets).length} markets loaded; ${contracts.length} active USDT-settled swaps`
    });
    const btc = contracts.find(m => m.base === "BTC");
    if (!btc) throw new Error("No active BTC/USDT USDT-settled perpetual in official market metadata");
    result.symbol = btc.symbol;
    const ticker = await exchange.fetchTicker(btc.symbol);
    if (!ticker || !Number.isFinite(Number(ticker.last))) throw new Error("BTC perpetual ticker has no valid last price");
    result.checks.push({ test: "BTC perpetual ticker", status: "PASS", detail: `${btc.symbol}; last=${ticker.last}` });

    const oneHour = await fetchHistory(exchange, btc.symbol, "1h", NEED["1h"]);
    result.history["1h"] = { candles: oneHour.bars.length, pages: oneHour.pages, latest: new Date(oneHour.bars.at(-1).timestamp).toISOString() };
    const cci1h = calculateCCI(oneHour.bars, 1200).at(-1);
    const ema5000 = calculateEMA(oneHour.bars.map(x=>x.close), 5000).at(-1);
    if (!Number.isFinite(cci1h) || !Number.isFinite(ema5000)) throw new Error("1h CCI(1200) or EMA(5000) is not finite");
    result.indicators = { cci1200_1h: cci1h, ema5000_1h: ema5000 };
    result.checks.push({ test: "1h history + CCI1200 + EMA5000", status: "PASS", detail: `${oneHour.bars.length} closed candles / ${oneHour.pages} pages` });

    let twoHour;
    let twoHourMethod = "native";
    if (exchange.timeframes?.["2h"]) {
      try { twoHour = await fetchHistory(exchange, btc.symbol, "2h", NEED["2h"]); }
      catch { twoHour = null; }
    }
    if (!twoHour) {
      const derived = aggregate1hTo2h(oneHour.bars);
      if (derived.length < NEED["2h"]) throw new Error(`2h history insufficient: native 2h unavailable and only ${derived.length}/${NEED["2h"]} complete 2h bars could be aggregated from 1h`);
      twoHour = { bars: derived.slice(-NEED["2h"]), pages: null };
      twoHourMethod = "aggregated from consecutive closed 1h candles";
    }
    const cci2h = calculateCCI(twoHour.bars, 1200).at(-1);
    if (!Number.isFinite(cci2h)) throw new Error("2h CCI(1200) is not finite");
    result.history["2h"] = { candles: twoHour.bars.length, method: twoHourMethod, pages: twoHour.pages, latest: new Date(twoHour.bars.at(-1).timestamp).toISOString() };
    result.indicators.cci1200_2h = cci2h;
    result.checks.push({ test: "2h history + CCI1200", status: "PASS", detail: `${twoHour.bars.length} closed candles; ${twoHourMethod}` });

    const fourHour = await fetchHistory(exchange, btc.symbol, "4h", NEED["4h"]);
    const fourHourValues = calculateLatestIndicators(fourHour.bars, { emaLength: 500, cciLength: 1200 });
    result.history["4h"] = { candles: fourHour.bars.length, pages: fourHour.pages, latest: new Date(fourHour.bars.at(-1).timestamp).toISOString() };
    result.indicators.ema500_4h = fourHourValues.ema;
    result.indicators.cci1200_4h = fourHourValues.cci;
    result.checks.push({ test: "4h history + EMA500 + CCI1200", status: "PASS", detail: `${fourHour.bars.length} closed candles / ${fourHour.pages} pages` });

    const fifteen = await fetchHistory(exchange, btc.symbol, "15m", NEED["15m"]);
    const cci15m = calculateCCI(fifteen.bars, 1200).at(-1);
    if (!Number.isFinite(cci15m)) throw new Error("15m CCI(1200) is not finite");
    result.history["15m"] = { candles: fifteen.bars.length, pages: fifteen.pages, latest: new Date(fifteen.bars.at(-1).timestamp).toISOString() };
    result.indicators.cci1200_15m = cci15m;
    result.checks.push({ test: "15m history + CCI1200", status: "PASS", detail: `${fifteen.bars.length} closed candles / ${fifteen.pages} pages` });

    const daily = await fetchHistory(exchange, btc.symbol, "1d", NEED["1d"]);
    const closes = daily.bars.map(x=>x.close);
    result.history["1d"] = { candles: daily.bars.length, pages: daily.pages, latest: new Date(daily.bars.at(-1).timestamp).toISOString() };
    result.indicators.ema20_1d = calculateEMA(closes,20).at(-1);
    result.indicators.ema50_1d = calculateEMA(closes,50).at(-1);
    result.checks.push({ test: "Daily history + EMA20 + EMA50", status: "PASS", detail: `${daily.bars.length} closed candles / ${daily.pages} pages` });

    result.status = result.checks.every(x=>x.status==="PASS") ? "PASS" : "PARTIAL";
    if (exchange.has?.fetchOpenInterest) {
      try {
        const oi = await exchange.fetchOpenInterest(btc.symbol);
        const value = oi?.openInterestAmount ?? oi?.openInterestValue;
        result.openInterest = value == null ? "PARTIAL: no numeric value" : "PASS";
      } catch (error) {
        result.openInterest = `UNAVAILABLE: ${error.name}: ${String(error.message).slice(0,140)}`;
      }
    } else {
      result.openInterest = "NOT SUPPORTED BY CCXT";
    }
  } catch (error) {
    result.error = `${error.name}: ${String(error.message).slice(0,500)}`;
  } finally {
    try { await exchange.close(); } catch {}
  }
  return result;
}

const report = [];
for (const config of EXCHANGES) {
  console.log(`START | ${config.label}`);
  const result = await checkExchange(config);
  report.push(result);
  console.log(JSON.stringify(result));
}
const passed = report.filter(x=>x.status==="PASS").length;
const partial = report.filter(x=>x.status==="PARTIAL").length;
const failed = report.filter(x=>x.status==="FAIL").length;
const payload = { generatedAt: new Date().toISOString(), candidateExchanges: EXCHANGES.map(x=>x.label), results: report, summary: { passed, partial, failed, total: report.length } };
await writeFile("final-seven-exchange-api-report.json", JSON.stringify(payload,null,2));
console.log(`FINAL | ${passed}/7 PASS | ${partial} PARTIAL | ${failed} FAIL`);
if (passed !== 7) process.exitCode = 1;

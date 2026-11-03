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
  const target = required + 8;
  let since = Date.now() - duration * (target + 8);
  let pages = 0;
  while (collected.size < target && pages < 70) {
    const before = collected.size;
    const remaining = target - collected.size;
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
  if (bars.length === 0) throw new Error(`No closed valid ${timeframe} candles returned after ${pages} pages`);
  const latest = bars.at(-1);
  const freshnessFloor = Math.floor(Date.now()/duration)*duration - duration*2;
  return { bars, pages, complete: bars.length >= required, fresh: latest.timestamp >= freshnessFloor, latest: latest.timestamp };
}
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Futures-scan-validation/1.0" }, signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0,180)}`);
    return body;
  } finally { clearTimeout(timer); }
}
async function fetchHtxHistory(contractCode, timeframe, required) {
  const periods = { "15m": "15min", "1h": "60min", "2h": "2hour", "4h": "4hour", "1d": "1day" };
  const duration = MS[timeframe] / 1000;
  const target = required + 8;
  const now = Math.floor(Date.now()/1000);
  const lastClosed = Math.floor(now/duration)*duration - duration;
  const firstNeeded = lastClosed - (target-1)*duration;
  const byTime = new Map();
  let pages = 0;
  const ranges = target <= 1900
    ? [{ from: null, to: null, size: target }]
    : Array.from({ length: Math.ceil(target/1900) }, (_,i) => {
        const from = firstNeeded + i*1900*duration;
        return { from, to: Math.min(lastClosed, from+1899*duration), size: null };
      });
  for (const range of ranges) {
    const url = new URL("https://api.hbdm.com/linear-swap-ex/market/history/kline");
    const params = { contract_code: contractCode, period: periods[timeframe] };
    if (range.size) params.size = String(Math.min(2000, range.size));
    else { params.from = String(range.from); params.to = String(range.to); }
    url.search = new URLSearchParams(params).toString();
    const payload = await getJson(url);
    if (payload.status !== "ok" || !Array.isArray(payload.data)) {
      throw new Error(`HTX ${timeframe} history rejected: ${payload.err_msg ?? payload.status}`);
    }
    for (const row of payload.data) {
      const bar = {
        timestamp: Number(row.id)*1000, open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.vol ?? row.amount)
      };
      if (![bar.timestamp,bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)) continue;
      if (bar.timestamp + MS[timeframe] > Date.now()) continue;
      if (bar.high < Math.max(bar.open,bar.close,bar.low) || bar.low > Math.min(bar.open,bar.close) || bar.volume < 0) continue;
      byTime.set(bar.timestamp,bar);
    }
    pages += 1;
    await sleep(300);
  }
  const bars = [...byTime.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-required);
  if (bars.length < required) throw new Error(`HTX returned only ${bars.length}/${required} closed valid ${timeframe} candles across ${pages} pages`);
  const latest = bars.at(-1).timestamp;
  const freshnessFloor = Math.floor(Date.now()/MS[timeframe])*MS[timeframe]-2*MS[timeframe];
  return { bars, pages, fresh: latest>=freshnessFloor, latest };
}
async function fetchVenueHistory(config, exchange, market, timeframe, required) {
  if (config.id === "htx") return fetchHtxHistory(market.id || market.symbol.replace("/", "-").replace(":USDT", ""), timeframe, required);
  return fetchHistory(exchange, market.symbol, timeframe, required);
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
function addCheck(result, name, ok, detail, core=false) {
  result.checks.push({ test: name, status: ok ? "PASS" : "FAIL", core, detail });
}
async function checkExchange(config) {
  const result = { exchange: config.label, ccxt: config.id, status: "FAIL", coreStatus: "FAIL", optionalStatus: "PARTIAL", checks: [], history: {}, indicators: {} };
  if (!ccxt.exchanges.includes(config.id)) {
    addCheck(result, "CCXT adapter", false, "Adapter missing from installed CCXT", true);
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
    addCheck(result, "Public markets / active USDT-settled perpetuals", contracts.length > 0,
      `${Object.keys(markets).length} markets loaded; ${contracts.length} active USDT-settled swaps`, true);
    const btc = contracts.find(m => m.base === "BTC");
    if (!btc) throw new Error("No active BTC/USDT USDT-settled perpetual in official market metadata");
    result.symbol = btc.symbol;
    const ticker = await exchange.fetchTicker(btc.symbol);
    const tickerOk = ticker && Number.isFinite(Number(ticker.last));
    addCheck(result, "BTC perpetual ticker", tickerOk, tickerOk ? `${btc.symbol}; last=${ticker.last}` : "Ticker has no valid last price", true);
    if (!tickerOk) throw new Error("BTC perpetual ticker has no valid last price");

    let oneHour = null;
    try {
      oneHour = await fetchVenueHistory(config, exchange, btc, "1h", NEED["1h"]);
      const cci1h = oneHour.bars.length >= 1200 ? calculateCCI(oneHour.bars, 1200).at(-1) : null;
      const ema5000 = oneHour.complete ? calculateEMA(oneHour.bars.map(x=>x.close), 5000).at(-1) : null;
      const fresh = oneHour.complete && oneHour.fresh && Number.isFinite(cci1h) && Number.isFinite(ema5000);
      result.history["1h"] = { candles: oneHour.bars.length, required: NEED["1h"], complete: oneHour.complete, pages: oneHour.pages, latest: new Date(oneHour.latest).toISOString(), fresh: oneHour.fresh };
      result.indicators.cci1200_1h = cci1h;
      result.indicators.ema5000_1h = ema5000;
      addCheck(result, "1h history + CCI1200 + EMA5000", fresh,
        `${oneHour.bars.length} closed candles / ${oneHour.pages} pages; latest=${new Date(oneHour.latest).toISOString()}`);
    } catch (error) {
      addCheck(result, "1h history + CCI1200 + EMA5000", false, error.message);
    }

    let twoHour = null;
    let twoHourMethod = "native";
    if (exchange.timeframes?.["2h"]) {
      try {
        twoHour = await fetchVenueHistory(config, exchange, btc, "2h", NEED["2h"]);
        if (twoHour.bars.length < NEED["2h"] || !twoHour.fresh) twoHour = null;
      } catch { twoHour = null; }
    }
    if (!twoHour && oneHour?.fresh) {
      const derived = aggregate1hTo2h(oneHour.bars);
      if (derived.length >= NEED["2h"]) {
        twoHour = { bars: derived.slice(-NEED["2h"]), pages: null, complete: true, fresh: true, latest: derived.at(-1).timestamp };
        twoHourMethod = "aggregated from consecutive closed 1h candles";
      }
    }
    if (twoHour) {
      const cci2h = calculateCCI(twoHour.bars, 1200).at(-1);
      const ok = twoHour.fresh && Number.isFinite(cci2h);
      result.history["2h"] = { candles: twoHour.bars.length, method: twoHourMethod, pages: twoHour.pages, latest: new Date(twoHour.latest).toISOString(), fresh: twoHour.fresh };
      result.indicators.cci1200_2h = cci2h;
      addCheck(result, "2h history + CCI1200", ok,
        `${twoHour.bars.length} closed candles; ${twoHourMethod}; latest=${new Date(twoHour.latest).toISOString()}`, true);
    } else {
      addCheck(result, "2h history + CCI1200", false, "No fresh 1200-candle native 2h history or valid 1h aggregation", true);
    }

    try {
      const fourHour = await fetchVenueHistory(config, exchange, btc, "4h", NEED["4h"]);
      const values = calculateLatestIndicators(fourHour.bars, { emaLength: 500, cciLength: 1200 });
      const ok = fourHour.fresh && Number.isFinite(values.ema) && Number.isFinite(values.cci);
      result.history["4h"] = { candles: fourHour.bars.length, pages: fourHour.pages, latest: new Date(fourHour.latest).toISOString(), fresh: fourHour.fresh };
      result.indicators.ema500_4h = values.ema;
      result.indicators.cci1200_4h = values.cci;
      addCheck(result, "4h history + EMA500 + CCI1200", ok,
        `${fourHour.bars.length} closed candles / ${fourHour.pages} pages; latest=${new Date(fourHour.latest).toISOString()}`, true);
    } catch (error) {
      addCheck(result, "4h history + EMA500 + CCI1200", false, error.message, true);
    }

    try {
      const fifteen = await fetchVenueHistory(config, exchange, btc, "15m", NEED["15m"]);
      const cci15m = calculateCCI(fifteen.bars, 1200).at(-1);
      const ok = fifteen.fresh && Number.isFinite(cci15m);
      result.history["15m"] = { candles: fifteen.bars.length, pages: fifteen.pages, latest: new Date(fifteen.latest).toISOString(), fresh: fifteen.fresh };
      result.indicators.cci1200_15m = cci15m;
      addCheck(result, "15m history + CCI1200", ok,
        `${fifteen.bars.length} closed candles / ${fifteen.pages} pages; latest=${new Date(fifteen.latest).toISOString()}`);
    } catch (error) {
      addCheck(result, "15m history + CCI1200", false, error.message);
    }

    try {
      const daily = await fetchVenueHistory(config, exchange, btc, "1d", NEED["1d"]);
      const closes = daily.bars.map(x=>x.close);
      const ema20 = calculateEMA(closes,20).at(-1);
      const ema50 = calculateEMA(closes,50).at(-1);
      const ok = daily.fresh && Number.isFinite(ema20) && Number.isFinite(ema50);
      result.history["1d"] = { candles: daily.bars.length, pages: daily.pages, latest: new Date(daily.latest).toISOString(), fresh: daily.fresh };
      result.indicators.ema20_1d = ema20;
      result.indicators.ema50_1d = ema50;
      addCheck(result, "Daily history + EMA20 + EMA50", ok,
        `${daily.bars.length} closed candles / ${daily.pages} pages; latest=${new Date(daily.latest).toISOString()}`);
    } catch (error) {
      addCheck(result, "Daily history + EMA20 + EMA50", false, error.message);
    }

    const coreChecks = result.checks.filter(x=>x.core);
    const optionalChecks = result.checks.filter(x=>!x.core);
    result.coreStatus = coreChecks.length===4 && coreChecks.every(x=>x.status==="PASS") ? "PASS" : "FAIL";
    result.optionalStatus = optionalChecks.length===3 && optionalChecks.every(x=>x.status==="PASS") ? "PASS" : "PARTIAL";
    result.status = result.coreStatus;
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
const corePassed = report.filter(x=>x.coreStatus==="PASS").length;
const optionalFull = report.filter(x=>x.optionalStatus==="PASS").length;
const coreFailed = report.length-corePassed;
const payload = { generatedAt: new Date().toISOString(), candidateExchanges: EXCHANGES.map(x=>x.label), results: report, summary: { corePassed, coreFailed, optionalFull, total: report.length } };
await writeFile("final-seven-exchange-api-report.json", JSON.stringify(payload,null,2));
console.log(`FINAL | CORE=${corePassed}/7 PASS | OPTIONAL_ALL_TIMEFRAMES=${optionalFull}/7 PASS | CORE_FAILED=${coreFailed}`);
if (corePassed !== 7) process.exitCode = 1;

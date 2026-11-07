import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory, TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";
import { createCcxtAdapter, fetchCcxtHistory, supportedCcxtExchanges } from "./ccxt-adapters.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const EXCHANGES = ["OKX", "MEXC", "BINGX", "WEEX", "KUCOIN", "XT"];
const TIMEFRAME_NAMES = Object.keys(TIMEFRAMES);
const REQUIRED_CLOSED = 1201;
const CCI_LENGTH = 1000;

function closedOnly(rows, timeframe) {
  const intervalMs = TIMEFRAMES[timeframe].seconds * 1000;
  return rows.filter(bar => bar.confirmed === false ? false :
    bar.confirmed === true ? true :
    Number.isFinite(bar.timestamp) && bar.timestamp + intervalMs <= Date.now());
}

async function fetchForExchange(exchange, adapter, symbol, timeframe) {
  const count = REQUIRED_CLOSED + 2;
  if (exchange === "OKX") {
    return fetchOkxHistory({
      base: process.env.OKX_BASE_URL ?? "https://openapi.okx.com",
      instId: symbol,
      bar: TIMEFRAMES[timeframe].okx,
      count
    });
  }
  if (exchange === "MEXC") {
    return fetchMexcHistory({
      base: process.env.MEXC_BASE_URL ?? "https://api.mexc.com",
      symbol,
      interval: timeframe,
      count
    });
  }
  return fetchCcxtHistory({ client: adapter.client, symbol, timeframe, count });
}

async function checkExchange(exchange) {
  const result = { exchange, status: "PASS", checks: [], history: {}, indicators: {} };
  let adapter;
  try {
    if (!["OKX", "MEXC", ...supportedCcxtExchanges()].includes(exchange)) {
      throw new Error("Exchange adapter is not supported");
    }
    let symbol;
    if (exchange === "OKX") symbol = "BTC-USDT-SWAP";
    else if (exchange === "MEXC") symbol = "BTC_USDT";
    else {
      adapter = await createCcxtAdapter(exchange);
      const market = adapter.symbols.find(item => item.baseAsset === "BTC" && Number.isFinite(item.lastPriceUsd));
      if (!market) throw new Error("Active BTC USDT perpetual with a valid ticker was not found");
      symbol = market.symbol;
    }
    result.symbol = symbol;

    for (const timeframe of TIMEFRAME_NAMES) {
      try {
        const raw = await fetchForExchange(exchange, adapter, symbol, timeframe);
        const bars = assertCandleCoverage(closedOnly(raw, timeframe).slice(-REQUIRED_CLOSED), timeframe, REQUIRED_CLOSED);
        const values = calculateLatestIndicators(bars, { cciLength: CCI_LENGTH });
        for (const key of ["close", "ema9", "ema20", "ema21", "ema50", "cci", "vwap"]) {
          if (!Number.isFinite(values[key])) throw new Error("Non-finite indicator: " + key);
        }
        const intervalMs = TIMEFRAMES[timeframe].seconds * 1000;
        const age = Date.now() - (bars.at(-1).timestamp + intervalMs);
        if (age < 0 || age > intervalMs * 2) throw new Error("Latest closed candle is stale: " + age + "ms");
        result.history[timeframe] = {
          status: "PASS",
          closedCandles: bars.length,
          latestClosedAt: new Date(bars.at(-1).timestamp).toISOString(),
          ageMs: age
        };
        result.indicators[timeframe] = {
          ema9: values.ema9, ema20: values.ema20, ema21: values.ema21,
          ema50: values.ema50, cci1000: values.cci, vwap: values.vwap
        };
        result.checks.push({ timeframe, status: "PASS" });
      } catch (error) {
        result.status = "FAIL";
        result.history[timeframe] = { status: "FAIL", error: error.message };
        result.checks.push({ timeframe, status: "FAIL", error: error.message });
      }
    }
  } catch (error) {
    result.status = "FAIL";
    result.error = error.message;
  } finally {
    await adapter?.client?.close?.();
  }
  return result;
}

const report = [];
for (const exchange of EXCHANGES) {
  console.log("START | " + exchange);
  const result = await checkExchange(exchange);
  report.push(result);
  console.log(JSON.stringify(result));
}
const passed = report.filter(row => row.status === "PASS").length;
const failed = report.length - passed;
const payload = {
  generatedAt: new Date().toISOString(),
  approvedExchanges: EXCHANGES,
  timeframes: TIMEFRAME_NAMES,
  requiredClosedCandles: REQUIRED_CLOSED,
  cciLength: CCI_LENGTH,
  results: report,
  summary: { passed, failed, total: report.length, timeframeChecks: report.reduce((n, row) => n + row.checks.length, 0) }
};
await writeFile("final-six-exchange-api-report.json", JSON.stringify(payload, null, 2));
console.log("FINAL | " + JSON.stringify(payload.summary));
if (failed > 0) process.exitCode = 1;

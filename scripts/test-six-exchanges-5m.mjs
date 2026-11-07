import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory, assertCandleCoverage } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { createCcxtAdapter, fetchCcxtHistory } from "./ccxt-adapters.mjs";

const REQUIRED = 1201;
const TF = "5m";
const INTERVAL = 300000;
const EXCHANGES = ["MEXC", "BINGX", "OKX", "WEEX", "KUCOIN", "XT"];

function closedOnly(rows) {
  const now = Date.now();
  return rows.filter(x => x.confirmed === false ? false :
    x.confirmed === true ? true :
    Number.isFinite(x.timestamp) && x.timestamp + INTERVAL <= now);
}

async function runOne(exchange) {
  let adapter;
  try {
    let raw, symbol = "BTC/USDT:USDT";
    if (exchange === "OKX") {
      raw = await fetchOkxHistory({base: process.env.OKX_BASE_URL ?? "https://openapi.okx.com",
        instId: "BTC-USDT-SWAP", bar: "5m", count: REQUIRED + 3});
      symbol = "BTC-USDT-SWAP";
    } else if (exchange === "MEXC") {
      raw = await fetchMexcHistory({base: process.env.MEXC_BASE_URL ?? "https://api.mexc.com",
        symbol: "BTC_USDT", interval: "5m", count: REQUIRED + 3});
      symbol = "BTC_USDT";
    } else {
      adapter = await createCcxtAdapter(exchange);
      const market = adapter.symbols.find(x => x.baseAsset === "BTC" &&
        x.marketInfo?.quote === "USDT" && x.marketInfo?.settle === "USDT");
      if (!market) throw new Error("Active BTC/USDT linear perpetual contract not found");
      symbol = market.symbol;
      raw = await fetchCcxtHistory({client: adapter.client, symbol, timeframe: TF, count: REQUIRED + 3});
    }
    const bars = assertCandleCoverage(closedOnly(raw), TF, REQUIRED);
    const values = calculateLatestIndicators(bars, {emaLength:500, cciLength:1200});
    for (const key of ["close", "ema9", "ema21", "ema", "cci", "vwap"]) {
      if (!Number.isFinite(values[key])) throw new Error("Invalid indicator result: " + key);
    }
    const age = Date.now() - values.timestamp;
    if (age < 0 || age > INTERVAL * 2) throw new Error("Latest closed candle is stale: " + age + "ms");
    return {exchange, status:"PASS", symbol, timeframe:TF, closedCandles:bars.length,
      firstCandleAt:new Date(bars[0].timestamp).toISOString(),
      lastClosedCandleAt:new Date(values.timestamp).toISOString(), latestCandleAgeMs:age,
      ema9:values.ema9, ema21:values.ema21, ema500:values.ema,
      cci1200:values.cci, vwap:values.vwap};
  } catch (error) {
    return {exchange, status:"FAIL", timeframe:TF, error:error?.message ?? String(error)};
  } finally {
    await adapter?.client?.close?.();
  }
}

const results = [];
for (const exchange of EXCHANGES) {
  const result = await runOne(exchange);
  results.push(result);
  console.log("EXCHANGE_RESULT " + JSON.stringify(result));
}
const summary = {test:"six-exchange-5m-live-history", generatedAt:new Date().toISOString(),
  requiredClosedCandles:REQUIRED, timeframe:TF, exchanges:EXCHANGES, results,
  passCount:results.filter(x=>x.status==="PASS").length,
  failCount:results.filter(x=>x.status!=="PASS").length};
await writeFile("5m-test-results.json", JSON.stringify(summary,null,2));
console.log("FINAL_SUMMARY " + JSON.stringify(summary));
if (summary.failCount) process.exitCode = 1;

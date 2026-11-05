import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { evaluateEntryEligibility, MAX_ENTRY_PRICE_USD } from "./entry-filters.mjs";

const CANDLE_COUNT = 2000;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const EXCHANGES = (process.env.EXCHANGES ?? "OKX,MEXC")
  .split(",").map(value => value.trim().toUpperCase()).filter(Boolean);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 0);
const SYMBOL_FILTER = (process.env.SYMBOLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const REQUIRE_DATA = process.env.REQUIRE_DATA === "true";

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.4" },
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429) {
        if (attempt === 4) throw new Error("HTTP 429 rate limit");
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 180)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Request failed");
}

async function getOkxSymbols(base) {
  const payload = await getJson(`${base}/api/v5/public/instruments?instType=SWAP`);
  if (payload.code !== "0" || !Array.isArray(payload.data)) {
    throw new Error(`OKX instrument list rejected: ${payload.msg ?? payload.code}`);
  }
  return payload.data
    .filter(item => item.state === "live" && item.settleCcy === "USDT")
    .map(item => ({
      exchange: "OKX",
      symbol: item.instId,
      baseAsset: item.baseCcy,
      base,
      display: item.instId
    }));
}

async function getMexcSymbols() {
  const payload = await getJson("https://api.mexc.com/api/v1/contract/detail");
  if (payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error(`MEXC contract list rejected: ${payload.message ?? payload.code}`);
  }
  return payload.data
    .filter(item => item.quoteCoin === "USDT" && item.settleCoin === "USDT" &&
      item.state === 0 && item.symbol?.endsWith("_USDT"))
    .map(item => ({
      exchange: "MEXC",
      symbol: item.symbol,
      baseAsset: item.baseCoin,
      display: item.symbol
    }));
}

async function getOkxPrices(base) {
  const payload = await getJson(`${base}/api/v5/market/tickers?instType=SWAP`);
  if (payload.code !== "0" || !Array.isArray(payload.data)) {
    throw new Error(`OKX ticker list rejected: ${payload.msg ?? payload.code}`);
  }
  return new Map(payload.data.map(item => [item.instId, Number(item.last)]));
}

async function getMexcPrices() {
  const payload = await getJson("https://api.mexc.com/api/v1/contract/ticker");
  if (payload.success !== true) {
    throw new Error(`MEXC ticker list rejected: ${payload.message ?? payload.code}`);
  }
  const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
  return new Map(rows.filter(Boolean).map(item => [item.symbol, Number(item.lastPrice)]));
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

function keepClosedFourHourCandles(bars, now = Date.now()) {
  const fourHoursMs = 4 * 60 * 60 * 1000;
  return bars.filter(bar => {
    if (bar.confirmed === false) return false;
    if (bar.confirmed === true) return true;
    return Number.isFinite(bar.timestamp) && bar.timestamp + fourHoursMs <= now;
  });
}

async function scanSymbol(item) {
  try {
    const raw = item.exchange === "OKX"
      ? await fetchOkxHistory({ base: item.base, instId: item.symbol, bar: "4H", count: CANDLE_COUNT })
      : await fetchMexcHistory({ symbol: item.symbol, interval: "4h", count: CANDLE_COUNT });
    const bars = keepClosedFourHourCandles(raw);
    if (bars.length < 1201) {
      throw new Error(`not enough closed candles: ${bars.length}/1201`);
    }
    const values = calculateLatestIndicators(bars, { emaLength: 500, cciLength: 1200 });
    return {
      exchange: item.exchange,
      symbol: item.display,
      status: "DATA_READY",
      baseAsset: item.baseAsset,
      lastPriceUsd: item.lastPriceUsd,
      candleTime: new Date(values.timestamp).toISOString(),
      close: values.close,
      ema500: values.ema,
      cci1200: values.cci,
      candleCount: values.candleCount
    };
  } catch (error) {
    return {
      exchange: item.exchange,
      symbol: item.display,
      status: "DATA_ERROR",
      baseAsset: item.baseAsset,
      lastPriceUsd: item.lastPriceUsd,
      error: error.message
    };
  }
}

if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 10) {
  throw new Error("CONCURRENCY must be an integer from 1 to 10");
}
if (EXCHANGES.some(exchange => !["OKX", "MEXC"].includes(exchange))) {
  throw new Error("Exchanges currently implemented in this repository: OKX, MEXC");
}
if (!Number.isInteger(MAX_SYMBOLS) || MAX_SYMBOLS < 0) {
  throw new Error("MAX_SYMBOLS must be 0 (unlimited) or a positive integer");
}

const exchangeInputs = await Promise.all(EXCHANGES.map(async exchange => {
  if (exchange === "OKX") {
    const bases = ["https://eea.okx.com", "https://openapi.okx.com"];
    let lastError;
    for (const base of bases) {
      try {
        const [symbols, prices] = await Promise.all([getOkxSymbols(base), getOkxPrices(base)]);
        return { symbols, prices };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error("OKX instruments/tickers unavailable");
  }
  const [symbols, prices] = await Promise.all([getMexcSymbols(), getMexcPrices()]);
  return { symbols, prices };
}));

const candidates = exchangeInputs.flatMap(({ symbols, prices }) =>
  symbols.map(item => ({ ...item, lastPriceUsd: prices.get(item.symbol) }))
);
const selectedCandidates = SYMBOL_FILTER.length > 0
  ? candidates.filter(item => SYMBOL_FILTER.includes(item.symbol))
  : candidates;

const rejected = [];
const eligible = [];
for (const item of selectedCandidates) {
  const decision = evaluateEntryEligibility({
    baseAsset: item.baseAsset,
    lastPrice: item.lastPriceUsd
  });
  if (decision.eligible) eligible.push(item);
  else rejected.push({
    exchange: item.exchange,
    symbol: item.display,
    baseAsset: item.baseAsset,
    lastPriceUsd: Number.isFinite(item.lastPriceUsd) ? item.lastPriceUsd : null,
    reason: decision.reason
  });
}

// MAX_SYMBOLS is a test-only cap, applied after the eligibility filters.
const universe = MAX_SYMBOLS > 0 ? eligible.slice(0, MAX_SYMBOLS) : eligible;
if (universe.length === 0) {
  throw new Error("No eligible contracts: check live USDT perpetuals, ticker availability, stablecoin exclusion and the <= $30 price rule");
}
console.log(`UNIVERSE | candidates=${selectedCandidates.length} | eligible=${eligible.length} | rejected=${rejected.length} | scanning=${universe.length} | maxEntryPriceUsd=${MAX_ENTRY_PRICE_USD}`);

let completed = 0;
const results = await mapLimit(universe, CONCURRENCY, async item => {
  const result = await scanSymbol(item);
  completed += 1;
  if (completed % 25 === 0 || completed === universe.length) {
    console.log(`PROGRESS | ${completed}/${universe.length}`);
  }
  return result;
});
const errors = results.filter(item => item.status === "DATA_ERROR");
const summary = {
  generatedAt: new Date().toISOString(),
  purpose: "Market data and indicator collection only; no long/short conditions or signals are applied.",
  entryFilters: {
    excludeStablecoinBaseAssets: true,
    maximumLastPriceUsd: MAX_ENTRY_PRICE_USD,
    priceSource: "exchange perpetual-contract last traded price; USDT treated as USD proxy"
  },
  exchanges: EXCHANGES,
  candidateCount: selectedCandidates.length,
  eligibleBeforeTestCap: eligible.length,
  rejectedCount: rejected.length,
  scanned: results.length,
  dataReady: results.filter(item => item.status === "DATA_READY").length,
  dataErrors: errors.length,
  rejected,
  results,
  errors
};
await writeFile("scan-results.json", JSON.stringify(summary, null, 2));
console.log(`SUMMARY | candidates=${selectedCandidates.length} | eligible=${eligible.length} | scanned=${results.length} | DATA_READY=${summary.dataReady} | DATA_ERROR=${errors.length} | rejected=${rejected.length}`);
console.log("RESULT_FILE | scan-results.json");
if (REQUIRE_DATA && errors.length > 0) process.exitCode = 1;

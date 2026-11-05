import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import {
  isLongSetupForSelectedTimeframes, keepClosedCandles, LONG_RULE_LABELS
} from "./strategy.mjs";
import { filterInitialUniverse, isUsdStablecoinBase } from "./initial-filter.mjs";

const CANDLE_COUNT_BY_TIMEFRAME = { "15m": 1200, "1h": 2000, "2h": 2000, "4h": 1200, "1d": 50 };
const OKX_BAR_BY_TIMEFRAME = { "15m": "15m", "1h": "1H", "2h": "2H", "4h": "4H", "1d": "1D" };
const SELECTED_TIMEFRAMES = [...new Set((process.env.TIMEFRAMES ?? "4h")
  .split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
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
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.3" },
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

async function getOkxSymbols() {
  const bases = ["https://eea.okx.com", "https://openapi.okx.com"];
  let lastError;
  for (const base of bases) {
    try {
      const payload = await getJson(`${base}/api/v5/public/instruments?instType=SWAP`);
      if (payload.code !== "0" || !Array.isArray(payload.data)) {
        throw new Error(`OKX instrument list rejected: ${payload.msg ?? payload.code}`);
      }
      return payload.data
        .filter(item => item.state === "live" && item.settleCcy === "USDT")
        .map(item => ({
          exchange: "OKX", symbol: item.instId, base,
          baseAsset: item.ctValCcy || item.instId.split("-")[0], display: item.instId
        }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("OKX instrument list unavailable");
}

async function getMexcSymbols() {
  const payload = await getJson("https://api.mexc.com/api/v1/contract/detail");
  if (payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error(`MEXC contract list rejected: ${payload.message ?? payload.code}`);
  }
  return payload.data
    .filter(item => item.quoteCoin === "USDT" && item.state === 0 && item.symbol?.endsWith("_USDT"))
    .map(item => ({
      exchange: "MEXC", symbol: item.symbol,
      baseAsset: item.baseCoin || item.symbol.split("_")[0], display: item.symbol
    }));
}


async function getOkxTicker(symbol) {
  const payload = await getJson(
    "https://www.okx.com/api/v5/market/ticker?instId=" + encodeURIComponent(symbol)
  );
  if (payload.code !== "0" || !Array.isArray(payload.data) || !payload.data[0]) {
    throw new Error(`OKX ticker rejected for ${symbol}: ${payload.msg ?? payload.code}`);
  }
  return Number(payload.data[0].last);
}

async function getMexcTicker(symbol) {
  const payload = await getJson(
    "https://api.mexc.com/api/v1/contract/ticker?symbol=" + encodeURIComponent(symbol)
  );
  if (!(payload.success === true || payload.code === 0)) {
    throw new Error(`MEXC ticker rejected for ${symbol}: ${payload.message ?? payload.code}`);
  }
  const rows = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
  const row = rows.find(item => item?.symbol === symbol) ?? rows[0];
  const price = Number(row?.lastPrice ?? row?.last ?? row?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`MEXC ticker has no current price for ${symbol}`);
  return price;
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

async function fetchTimeframeHistory(item, timeframe) {
  const count = CANDLE_COUNT_BY_TIMEFRAME[timeframe];
  if (!count) throw new Error(`Unsupported selected timeframe: ${timeframe}`);
  if (item.exchange === "OKX") {
    return fetchOkxHistory({
      base: item.base,
      instId: item.symbol,
      bar: OKX_BAR_BY_TIMEFRAME[timeframe],
      count
    });
  }
  return fetchMexcHistory({ symbol: item.symbol, interval: timeframe, count });
}

function indicatorOptionsForTimeframe(timeframe) {
  if (timeframe === "4h") return { emaLengths: [500], cciLength: 1200 };
  if (timeframe === "1h" || timeframe === "2h") return { emaLengths: [2000], cciLength: 1200 };
  if (timeframe === "15m") return { emaLengths: [9, 21], cciLength: 1200, includeVWAP: true };
  if (timeframe === "1d") return { emaLengths: [20, 50], cciLength: null };
  throw new Error(`Unsupported selected timeframe: ${timeframe}`);
}

function mapTimeframeValues(timeframe, indicators) {
  if (timeframe === "4h") return {
    close: indicators.close, ema500: indicators.emas.ema500, cci1200: indicators.cci,
    candleTime: indicators.timestamp, candleCount: indicators.candleCount
  };
  if (timeframe === "1h" || timeframe === "2h") return {
    close: indicators.close, ema2000: indicators.emas.ema2000, cci1200: indicators.cci,
    candleTime: indicators.timestamp, candleCount: indicators.candleCount
  };
  if (timeframe === "15m") return {
    close: indicators.close, ema9: indicators.emas.ema9, ema21: indicators.emas.ema21,
    vwap: indicators.vwap, cci1200: indicators.cci,
    candleTime: indicators.timestamp, candleCount: indicators.candleCount
  };
  return {
    close: indicators.close, ema20: indicators.emas.ema20, ema50: indicators.emas.ema50,
    candleTime: indicators.timestamp, candleCount: indicators.candleCount
  };
}

async function scanSymbol(item) {
  try {
    const valuesByTimeframe = {};
    for (const timeframe of SELECTED_TIMEFRAMES) {
      const raw = await fetchTimeframeHistory(item, timeframe);
      const bars = keepClosedCandles(raw, timeframe);
      const required = CANDLE_COUNT_BY_TIMEFRAME[timeframe];
      if (bars.length < required) {
        throw new Error(`not enough closed ${timeframe} candles: ${bars.length}/${required}`);
      }
      const indicators = calculateLatestIndicators(bars, indicatorOptionsForTimeframe(timeframe));
      valuesByTimeframe[timeframe] = mapTimeframeValues(timeframe, indicators);
    }
    const passed = isLongSetupForSelectedTimeframes(valuesByTimeframe, SELECTED_TIMEFRAMES);
    return {
      exchange: item.exchange,
      symbol: item.display,
      status: passed ? "LONG" : "NO_MATCH",
      selectedTimeframes: SELECTED_TIMEFRAMES,
      timeframes: Object.fromEntries(SELECTED_TIMEFRAMES.map(timeframe => [
        timeframe,
        { ...valuesByTimeframe[timeframe], passed: isLongSetupForSelectedTimeframes(
          { [timeframe]: valuesByTimeframe[timeframe] }, [timeframe]
        ) }
      ]))
    };
  } catch (error) {
    return {
      exchange: item.exchange,
      symbol: item.display,
      status: "DATA_ERROR",
      error: error.message
    };
  }
}

if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 10) {
  throw new Error("CONCURRENCY must be an integer from 1 to 10");
}
if (EXCHANGES.some(exchange => !["OKX", "MEXC"].includes(exchange))) {
  throw new Error("Supported scan adapters in this stage: OKX, MEXC");
}
const validTimeframes = new Set(Object.keys(CANDLE_COUNT_BY_TIMEFRAME));
if (SELECTED_TIMEFRAMES.length === 0 || SELECTED_TIMEFRAMES.some(timeframe => !validTimeframes.has(timeframe))) {
  throw new Error("TIMEFRAMES must contain one or more of: 15m,1h,2h,4h,1d");
}

const symbolLists = await Promise.all(EXCHANGES.map(async exchange => {
  const allSymbols = exchange === "OKX" ? await getOkxSymbols() : await getMexcSymbols();
  const symbols = SYMBOL_FILTER.length > 0
    ? allSymbols.filter(item => SYMBOL_FILTER.includes(item.symbol))
    : allSymbols;
  // Reject stablecoins from contract metadata before making any price request.
  const nonStablecoinSymbols = symbols.filter(item => !isUsdStablecoinBase(item.baseAsset));
  const tickers = new Map();
  await mapLimit(nonStablecoinSymbols, Math.max(1, Math.min(CONCURRENCY, 4)), async item => {
    try {
      const price = exchange === "OKX"
        ? await getOkxTicker(item.symbol)
        : await getMexcTicker(item.symbol);
      tickers.set(item.symbol, price);
    } catch (error) {
      console.warn(`PRICE_UNAVAILABLE | ${exchange} | ${item.symbol} | ${String(error.message || error).slice(0, 180)}`);
    }
  });
  const gate = filterInitialUniverse(symbols, tickers, 30);
  console.log(
    `INITIAL_FILTER | ${exchange} | candidates=${gate.counts.candidates} | allowed=${gate.counts.allowed} | stablecoins=${gate.counts.stablecoin} | above30=${gate.counts.abovePrice} | noPrice=${gate.counts.priceUnavailable}`
  );
  const selected = SYMBOL_FILTER.length > 0
    ? gate.allowed.filter(item => SYMBOL_FILTER.includes(item.symbol))
    : gate.allowed;
  return MAX_SYMBOLS > 0 ? selected.slice(0, MAX_SYMBOLS) : selected;
}));
const universe = symbolLists.flat();
if (universe.length === 0) throw new Error("No matching USDT perpetual contracts found for the selected exchanges/symbols");
console.log(`UNIVERSE | ${universe.length} USDT perpetual contracts | exchanges=${EXCHANGES.join(",")} | concurrency=${CONCURRENCY}`);

let completed = 0;
const results = await mapLimit(universe, CONCURRENCY, async item => {
  const result = await scanSymbol(item);
  completed += 1;
  if (completed % 25 === 0 || completed === universe.length) {
    console.log(`PROGRESS | ${completed}/${universe.length} | LONG matches pending final aggregation`);
  }
  return result;
});
const matches = results.filter(item => item.status === "LONG");
const errors = results.filter(item => item.status === "DATA_ERROR");
const summary = {
  generatedAt: new Date().toISOString(),
  direction: "LONG",
  selectedTimeframes: SELECTED_TIMEFRAMES,
  rule: SELECTED_TIMEFRAMES.map(timeframe => LONG_RULE_LABELS[timeframe]).join(" AND "),
  exchanges: EXCHANGES,
  scanned: results.length,
  longMatches: matches.length,
  dataErrors: errors.length,
  matches,
  errors
};
await writeFile("scan-results.json", JSON.stringify(summary, null, 2));
console.log(`SUMMARY | scanned=${results.length} | LONG=${matches.length} | DATA_ERROR=${errors.length}`);
console.log("RESULT_FILE | scan-results.json");
if (REQUIRE_DATA && errors.length > 0) process.exitCode = 1;

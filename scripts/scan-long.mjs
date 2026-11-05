import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";
import { filterInitialUniverse, isUsdStablecoinBase } from "./initial-filter.mjs";

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
    const passed = isLongSetup({ close: values.close, ema500: values.ema, cci1200: values.cci });
    return {
      exchange: item.exchange,
      symbol: item.display,
      status: passed ? "LONG" : "NO_MATCH",
      close: values.close,
      ema500: values.ema,
      cci1200: values.cci,
      candleTime: new Date(values.timestamp).toISOString()
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
  throw new Error("Supported exchanges in this stage: OKX, MEXC");
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
  rule: "4h close > EMA500 AND CCI(1200) > 100",
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

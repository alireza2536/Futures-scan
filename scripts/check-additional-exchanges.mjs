import ccxt from "ccxt";
import { calculateLatestIndicators } from "./indicators.mjs";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";

const TARGETS = [
  { timeframe: "15m", count: 2000 },
  { timeframe: "4h", count: 2000 }
];
const EXCHANGES = [
  { id: "bitget", label: "Bitget" },
  { id: "gate", label: "Gate.io" },
  { id: "bingx", label: "BingX" },
  { id: "weex", label: "WEEX" },
  { id: "kucoinfutures", label: "KuCoin Futures" },
  { id: "coinbaseinternational", label: "Coinbase International" },
];
const INTERVAL_MS = { "15m": 900000, "4h": 14400000 };

function validOhlcv(row) {
  return Array.isArray(row) && row.length >= 6 &&
    Number.isFinite(Number(row[0])) &&
    [1, 2, 3, 4, 5].every(i => Number.isFinite(Number(row[i]))) &&
    Number(row[2]) >= Number(row[3]) &&
    Number(row[2]) >= Math.max(Number(row[1]), Number(row[4])) &&
    Number(row[3]) <= Math.min(Number(row[1]), Number(row[4]));
}

async function fetchHistory(exchange, symbol, timeframe, count) {
  const duration = INTERVAL_MS[timeframe];
  const collected = new Map();
  let since = Date.now() - duration * count;
  let pages = 0;
  while (collected.size < count && pages < 12) {
    const remaining = count - collected.size;
    const limit = Math.min(1000, Math.max(100, remaining + 10));
    const rows = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) if (validOhlcv(row)) collected.set(Number(row[0]), row);
    const newest = Math.max(...rows.map(row => Number(row[0])).filter(Number.isFinite));
    if (!Number.isFinite(newest) || newest < since || rows.length < 2) break;
    since = newest + duration;
    pages += 1;
    if (since >= Date.now()) break;
  }
  return [...collected.values()].sort((a, b) => a[0] - b[0]).slice(-count);
}

function rowsToBars(rows) {
  return rows.map(row => ({
    timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])
  }));
}

async function checkExchange(config) {
  const output = { exchange: config.label, status: "BLOCKED", checks: [] };
  if (!ccxt.exchanges.includes(config.id)) {
    output.checks.push({ test: "CCXT adapter", status: "FAIL", detail: "Adapter not present in installed CCXT version" });
    return output;
  }
  const exchange = new ccxt[config.id]({
    enableRateLimit: true,
    timeout: 25000,
    options: { defaultType: "swap" }
  });
  try {
    const markets = await exchange.loadMarkets();
    const allMarkets = Object.values(markets);
    if (config.id === "coinbaseinternational") {
      const btcDerivatives = allMarkets.filter(m => m && m.base === "BTC" && m.contract === true && m.swap === true);
      output.btcDerivativeMarkets = btcDerivatives.map(m => ({ symbol: m.symbol, quote: m.quote, settle: m.settle, active: m.active }));
    }
    const futures = allMarkets.filter(m =>
      m && m.active !== false && m.contract === true && m.swap === true &&
      m.quote === "USDT" && m.settle === "USDT"
    );
    output.checks.push({
      test: "Public API + USDT perpetual contract list",
      status: futures.length ? "PASS" : "FAIL",
      detail: `${Object.keys(markets).length} markets loaded; ${futures.length} active USDT-settled perpetuals`
    });
    const btc = futures.find(m => m.base === "BTC");
    if (!btc) throw new Error("No active BTC/USDT USDT-settled perpetual contract found");
    output.symbol = btc.symbol;
    output.checks.push({ test: "BTC USDT perpetual", status: "PASS", detail: `${btc.symbol} (${btc.id})` });

    const historyResults = {};
    for (const target of TARGETS) {
      try {
        const duration = INTERVAL_MS[target.timeframe];
        if (!exchange.timeframes || !exchange.timeframes[target.timeframe]) {
          throw new Error(`Timeframe ${target.timeframe} is not supported by this exchange adapter`);
        }
        const rows = await fetchHistory(exchange, btc.symbol, target.timeframe, target.count);
        const minimum = 1201;
        if (rows.length < minimum) {
          throw new Error(`Only ${rows.length}/${target.count} valid candles returned; minimum required ${minimum}`);
        }
        const latestTimestamp = Number(rows.at(-1)[0]);
        const currentBucket = Math.floor(Date.now() / duration) * duration;
        const freshnessFloor = currentBucket - duration;
        if (latestTimestamp < freshnessFloor) {
          throw new Error(`Latest candle is stale: ${new Date(latestTimestamp).toISOString()}; expected at or after ${new Date(freshnessFloor).toISOString()}`);
        }
        const bars = rowsToBars(rows);
        historyResults[target.timeframe] = bars;
        if (target.timeframe === "4h") {
          const closed = keepClosedFourHourCandles(bars);
          if (closed.length < 1201) throw new Error(`Only ${closed.length} closed 4h candles; need 1201`);
          const values = calculateLatestIndicators(closed, { cciLength: 1000 });
          const longRule = isLongSetup({ cci1000: values.cci });
          output.indicators = {
            candleTime: new Date(values.timestamp).toISOString(),
            close: values.close, ema9: values.ema9, ema20: values.ema20,
            ema21: values.ema21, ema50: values.ema50, cci1000: values.cci,
            longConditionMet: longRule
          };
        }
        output.checks.push({
          test: `${target.timeframe} candle history + OHLCV validation`,
          status: "PASS",
          detail: `${rows.length} valid candles; latest=${new Date(rows.at(-1)[0]).toISOString()}`
        });
      } catch (error) {
        output.checks.push({ test: `${target.timeframe} candle history`, status: "FAIL", detail: error.message });
      }
    }
    const required = output.checks.filter(x =>
      x.test === "Public API + USDT perpetual contract list" ||
      x.test === "BTC USDT perpetual" ||
      x.test.includes("candle history")
    );
    output.status = required.every(x => x.status === "PASS") ? "PASS" : "BLOCKED";
    output.history = Object.fromEntries(Object.entries(historyResults).map(([tf, bars]) => [tf, bars.length]));
  } catch (error) {
    output.checks.push({ test: "Exchange access", status: "FAIL", detail: error.message });
  } finally {
    try { await exchange.close(); } catch {}
  }
  return output;
}

const results = [];
for (const config of EXCHANGES) {
  console.log(`START | ${config.label}`);
  try {
    const result = await checkExchange(config);
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { exchange: config.label, status: "BLOCKED", error: error.message };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
const approved = results.filter(x => x.status === "PASS").map(x => x.exchange);
console.log(`FINAL | approved=${approved.length}/${results.length} | ${approved.join(",") || "none"}`);
await import("node:fs/promises").then(fs => fs.writeFile("additional-exchange-results.json", JSON.stringify({
  generatedAt: new Date().toISOString(), results, approved
}, null, 2)));
if (approved.length === 0) process.exitCode = 1;

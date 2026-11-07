import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const COUNT = 1203;
const TIMEFRAME = "4h";
const INTERVAL_MS = 4 * 60 * 60 * 1000;

function closedBars(bars) {
  return bars.filter(bar => bar.timestamp + INTERVAL_MS <= Date.now());
}

async function inspect(exchange, fetcher) {
  const raw = await fetcher();
  const bars = closedBars(raw).slice(-1201);
  if (bars.length < 1201) throw new Error(`${exchange}: only ${bars.length}/1201 closed candles`);
  const values = calculateLatestIndicators(bars, { cciLength: 1000 });
  return bars.slice(-5).map((bar, offset) => {
    const index = bars.length - 5 + offset;
    return {
      exchange,
      timestamp: new Date(bar.timestamp).toISOString(),
      close: bar.close,
      ema9: values.ema9,
      ema20: values.ema20,
      ema21: values.ema21,
      ema50: values.ema50,
      cci1000: values.cci,
      vwap: values.vwap,
      candleCount: index + 1
    };
  });
}

const jobs = [
  ["OKX", () => fetchOkxHistory({ instId: "BTC-USDT-SWAP", bar: "4H", count: COUNT })],
  ["MEXC", () => fetchMexcHistory({ symbol: "BTC_USDT", interval: "4h", count: COUNT })]
];

let failures = 0;
for (const [name, fetcher] of jobs) {
  try {
    const rows = await inspect(name, fetcher);
    for (const row of rows) console.log("BAR | " + JSON.stringify(row));
  } catch (error) {
    failures += 1;
    console.error(`ERROR | ${name} | ${error.message}`);
  }
}
if (failures === jobs.length) process.exitCode = 1;

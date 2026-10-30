import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateEMA, calculateCCI } from "./indicators.mjs";

const COUNT = 2000;
const now = Date.now();
const intervalMs = 4 * 60 * 60 * 1000;

function closedBars(bars) {
  return bars.filter(bar => bar.timestamp + intervalMs <= now);
}

function rowsFor(bars, label) {
  const closed = closedBars(bars);
  if (closed.length < 1200) throw new Error(`${label}: only ${closed.length} closed candles available`);
  const closes = closed.map(x => x.close);
  const ema = calculateEMA(closes, 500);
  const cci = calculateCCI(closed, 1200);
  return closed.slice(-5).map((bar, offset) => {
    const i = closed.length - 5 + offset;
    return {
      exchange: label,
      timestamp: new Date(bar.timestamp).toISOString(),
      close: bar.close,
      ema500: ema[i],
      cci1200: cci[i],
      candleCount: i + 1
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
    const bars = await fetcher();
    for (const row of rowsFor(bars, name)) {
      console.log([
        "BAR",
        row.exchange,
        row.timestamp,
        `close=${row.close}`,
        `EMA500=${row.ema500}`,
        `CCI1200=${row.cci1200}`,
        `history=${row.candleCount}`
      ].join(" | "));
    }
  } catch (error) {
    failures += 1;
    console.error(`ERROR | ${name} | ${error.message}`);
  }
}
if (failures === jobs.length) process.exitCode = 1;

import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateEMA, calculateLatestIndicators } from "./indicators.mjs";

const LONG_HISTORY = 1201;
const TARGETS = [
  { label: "15m", okx: "15m", mexc: "15m", count: LONG_HISTORY, mode: "cci" },
  { label: "4h", okx: "4H", mexc: "4h", count: LONG_HISTORY, mode: "cci" },
  { label: "1d", okx: "1D", mexc: "1d", count: 60, mode: "daily" }
];

async function calculate(name, bars, mode) {
  if (mode === "daily") {
    const closes = bars.map(bar => bar.close);
    const ema20 = calculateEMA(closes, 20).at(-1);
    const ema50 = calculateEMA(closes, 50).at(-1);
    console.log(`PASS | ${name} | candles=${bars.length} | close=${closes.at(-1)} | EMA20=${ema20} | EMA50=${ema50}`);
  } else {
    const result = calculateLatestIndicators(bars, { emaLength: 500, cciLength: 1200 });
    console.log(`PASS | ${name} | candles=${bars.length} | close=${result.close} | EMA500=${result.ema} | CCI1200=${result.cci}`);
  }
}

async function check(name, fetcher, mode) {
  try {
    const bars = await fetcher();
    await calculate(name, bars, mode);
    return "PASS";
  } catch (error) {
    console.error(`BLOCKED | ${name} | ${error.message}`);
    return "BLOCKED";
  }
}

const okxBases = ["https://eea.okx.com", "https://openapi.okx.com"];
const checks = [];
for (const target of TARGETS) {
  checks.push((async () => {
    let lastError;
    for (const base of okxBases) {
      try {
        const bars = await fetchOkxHistory({ base, bar: target.okx, count: target.count });
        await calculate(`OKX ${target.label} (${base})`, bars, target.mode);
        return "PASS";
      } catch (error) {
        lastError = error;
      }
    }
    console.error(`BLOCKED | OKX ${target.label} | ${lastError?.message ?? "both API domains failed"}`);
    return "BLOCKED";
  })());
  checks.push(check(`MEXC ${target.label}`, () =>
    fetchMexcHistory({ interval: target.mexc, count: target.count }), target.mode));
}

const results = await Promise.all(checks);
const passed = results.filter(x => x === "PASS").length;
const blocked = results.filter(x => x === "BLOCKED").length;
console.log(`HISTORY SUMMARY | ${passed}/${results.length} passed | ${blocked} blocked by data/API limits`);
// This workflow is a diagnostic gate: expected history-retention limits are reported,
// not hidden as fake data or treated as successful indicator calculations.
if (passed === 0) process.exitCode = 1;

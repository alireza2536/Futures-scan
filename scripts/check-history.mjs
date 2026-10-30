import { fetchOkxHistory, fetchMexcHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const COUNT = 1201;
const TARGETS = [
  { label: "15m", okx: "15m", mexc: "15m" },
  { label: "4h", okx: "4H", mexc: "4h" },
  { label: "1d", okx: "1D", mexc: "1d" }
];

async function check(name, fetcher) {
  try {
    const bars = await fetcher();
    const result = calculateLatestIndicators(bars);
    console.log(`PASS | ${name} | candles=${bars.length} | close=${result.close} | EMA500=${result.ema} | CCI1200=${result.cci}`);
    return true;
  } catch (error) {
    console.error(`FAIL | ${name} | ${error.message}`);
    return false;
  }
}

const okxBases = ["https://eea.okx.com", "https://openapi.okx.com"];
const checks = [];
for (const target of TARGETS) {
  checks.push((async () => {
    let lastError;
    for (const base of okxBases) {
      try {
        return await check(`OKX ${base} ${target.label}`, () =>
          fetchOkxHistory({ base, bar: target.okx, count: COUNT })
        );
      } catch (error) {
        lastError = error;
      }
    }
    console.error(`FAIL | OKX ${target.label} | ${lastError?.message ?? "all domains failed"}`);
    return false;
  })());
  checks.push(check(`MEXC ${target.label}`, () =>
    fetchMexcHistory({ interval: target.mexc, count: COUNT })
  ));
}

const results = await Promise.all(checks);
const passed = results.filter(Boolean).length;
console.log(`HISTORY SUMMARY | ${passed}/${results.length} exchange/timeframe checks passed`);
if (passed !== results.length) process.exitCode = 1;

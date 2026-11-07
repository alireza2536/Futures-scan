import test from "node:test";
import assert from "node:assert/strict";
import { calculateEMA } from "./indicators.mjs";
import { createEmaState, advanceEmaState } from "./ema-state.mjs";

const interval = 300000;
function bars(count, start = 0) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.17 + Math.sin(i / 7);
    return { timestamp: (start + i) * interval, open: close, high: close + 1,
      low: close - 1, close, volume: 10, confirmed: true };
  });
}

test("EMA500 initializes from closed contiguous history and matches reference calculation", () => {
  const seed = bars(1000);
  const state = createEmaState(seed, { timeframeMs: interval, length: 500 });
  const expected = calculateEMA(seed.map(bar => bar.close), 500).at(-1);
  assert.ok(Math.abs(state.value - expected) < 1e-10);
  assert.equal(state.lastTimestamp, seed.at(-1).timestamp);
  assert.equal(state.history.length, seed.length);
  assert.equal(state.history.at(-1).value, state.value);
});

test("EMA state advances one new candle without historical bars", () => {
  const seed = bars(1000);
  const state = createEmaState(seed, { timeframeMs: interval, length: 500 });
  const next = bars(1, 1000)[0];
  const advanced = advanceEmaState(state, next);
  const expected = calculateEMA([...seed.map(bar => bar.close), next.close], 500).at(-1);
  assert.ok(Math.abs(advanced.value - expected) < 1e-10);
  assert.equal(advanced.candlesProcessed, 1001);
  assert.equal(advanced.history.length, 1);
  assert.equal(advanced.history[0].timestamp, next.timestamp);
  assert.equal(state.lastTimestamp, seed.at(-1).timestamp);
});

test("EMA state rejects gaps, duplicates, unclosed and invalid candles", () => {
  const seed = bars(500);
  const state = createEmaState(seed, { timeframeMs: interval, length: 500 });
  assert.throws(() => advanceEmaState(state, bars(1, 501)[0]), /next contiguous/);
  assert.throws(() => advanceEmaState(state, { ...bars(1, 500)[0], confirmed: false }), /Unclosed/);
  assert.throws(() => advanceEmaState(state, { ...bars(1, 500)[0], close: NaN }), /Invalid/);
  assert.throws(() => createEmaState([seed[0], seed[2], ...seed.slice(3)], { timeframeMs: interval, length: 500 }), /gap/);
});

test("EMA initialization requires at least EMA length candles", () => {
  assert.throws(() => createEmaState(bars(499), { timeframeMs: interval, length: 500 }), /At least 500/);
});

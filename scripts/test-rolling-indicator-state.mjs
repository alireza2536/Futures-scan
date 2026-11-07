import test from "node:test";
import assert from "node:assert/strict";
import { calculateCCI, calculateVWAP } from "./indicators.mjs";
import { createRollingIndicatorState, advanceRollingIndicatorState } from "./rolling-indicator-state.mjs";

const INTERVAL = 5 * 60 * 1000;
const start = Date.UTC(2026, 10, 6, 23, 40);
function barsFrom(count) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 4 + i * 0.07;
    return { timestamp: start + i * INTERVAL, open: close - 0.4, high: close + 1.2, low: close - 1.1, close, volume: 10 + i, confirmed: true };
  });
}

test("rolling CCI state matches full-history CCI and retains only the configured TP window", () => {
  const history = barsFrom(9);
  const seed = history.slice(0, 6);
  let state = createRollingIndicatorState(seed, { timeframeMs: INTERVAL, cciLength: 5 });
  assert.equal(state.typicalPrices.length, 5);
  assert.ok(Math.abs(state.cci - calculateCCI(seed, 5).at(-1)) < 1e-12);
  for (const bar of history.slice(6)) {
    state = advanceRollingIndicatorState(state, bar);
    const prefix = history.slice(0, history.findIndex(x => x.timestamp === bar.timestamp) + 1);
    assert.ok(Math.abs(state.cci - calculateCCI(prefix, 5).at(-1)) < 1e-10);
    assert.equal(state.typicalPrices.length, 5);
  }
});

test("rolling session VWAP matches full calculation and resets at UTC midnight", () => {
  const history = barsFrom(8);
  let state = createRollingIndicatorState(history.slice(0, 6), { timeframeMs: INTERVAL, cciLength: 5 });
  assert.ok(Math.abs(state.vwap - calculateVWAP(history.slice(0, 6)).at(-1)) < 1e-12);
  for (const bar of history.slice(6)) {
    state = advanceRollingIndicatorState(state, bar);
    const prefix = history.slice(0, history.findIndex(x => x.timestamp === bar.timestamp) + 1);
    assert.ok(Math.abs(state.vwap - calculateVWAP(prefix).at(-1)) < 1e-10);
  }
  assert.equal(state.sessionDateUtc, "2026-11-07");
});

test("rolling state rejects gaps, duplicate candles, and unclosed candles", () => {
  const seed = barsFrom(6);
  const state = createRollingIndicatorState(seed, { timeframeMs: INTERVAL, cciLength: 5 });
  assert.throws(() => advanceRollingIndicatorState(state, { ...seed[5], timestamp: seed[5].timestamp + 2 * INTERVAL }), /next contiguous/);
  assert.throws(() => advanceRollingIndicatorState(state, { ...seed[5], timestamp: seed[5].timestamp + INTERVAL, confirmed: false }), /Unclosed candle/);
});

test("rolling state requires CCI length plus one closed candle for project coverage", () => {
  assert.throws(() => createRollingIndicatorState(barsFrom(5), { timeframeMs: INTERVAL, cciLength: 5 }), /At least 6 closed candles/);
});

test("full CCI1000 rolling window matches full-history calculation after one new candle", () => {
  const history = barsFrom(1002);
  let state = createRollingIndicatorState(history.slice(0, 1001), { timeframeMs: INTERVAL, cciLength: 1000 });
  assert.equal(state.typicalPrices.length, 1000);
  assert.ok(Math.abs(state.cci - calculateCCI(history.slice(0, 1001), 1000).at(-1)) < 1e-9);
  state = advanceRollingIndicatorState(state, history[1001]);
  assert.ok(Math.abs(state.cci - calculateCCI(history, 1000).at(-1)) < 1e-9);
  assert.equal(state.typicalPrices.length, 1000);
});

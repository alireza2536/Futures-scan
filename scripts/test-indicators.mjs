import test from "node:test";
import assert from "node:assert/strict";
import { calculateCCI, calculateEMA, calculateLatestIndicators } from "./indicators.mjs";

test("EMA matches TradingView ta.ema first-value seed and recursion", () => {
  assert.deepEqual(calculateEMA([1, 2, 3, 4, 5], 3), [1, 1.5, 2.25, 3.125, 4.0625]);
});

test("CCI is zero for a constant typical-price series", () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({
    high: 11, low: 9, close: 10, open: 10, volume: 1, timestamp: i
  }));
  assert.deepEqual(calculateCCI(bars, 3), [null, null, 0, 0, 0]);
});

test("CCI returns 100 for a steadily rising typical-price sequence", () => {
  const bars = Array.from({ length: 4 }, (_, i) => ({
    high: i + 2, low: i, close: i + 1, open: i + 1, volume: 1, timestamp: i
  }));
  const value = calculateCCI(bars, 3).at(-1);
  assert.ok(Math.abs(value - 100) < 1e-10);
});

test("latest indicator calculation requires the requested history", () => {
  const bars = Array.from({ length: 1200 }, (_, i) => ({
    high: 101 + i, low: 99 + i, close: 100 + i,
    open: 100 + i, volume: 1, timestamp: i
  }));
  const result = calculateLatestIndicators(bars);
  assert.equal(result.candleCount, 1200);
  assert.ok(Number.isFinite(result.ema));
  assert.ok(Number.isFinite(result.cci));
  assert.throws(() => calculateLatestIndicators(bars.slice(0, 1199)), /At least 1200/);
});

test("calculateLatestIndicators supports multiple EMA lengths and optional CCI", () => {
  const bars = Array.from({ length: 50 }, (_, index) => ({
    timestamp: Date.UTC(2026, 0, 1) + index * 86400000,
    open: index + 1, high: index + 2, low: index, close: index + 1.5, volume: 10
  }));
  const result = calculateLatestIndicators(bars, { emaLengths: [20, 50], cciLength: null });
  assert.equal(Number.isFinite(result.emas.ema20), true);
  assert.equal(Number.isFinite(result.emas.ema50), true);
  assert.equal(result.cci, null);
});

test("session VWAP uses the last UTC session only", () => {
  const day = Date.UTC(2026, 0, 2);
  const bars = [
    { timestamp: day - 60000, high: 11, low: 9, close: 10, volume: 100 },
    { timestamp: day, high: 21, low: 19, close: 20, volume: 1 },
    { timestamp: day + 60000, high: 31, low: 29, close: 30, volume: 1 }
  ];
  assert.equal(calculateSessionVWAP(bars), 25);
});

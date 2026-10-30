import test from "node:test";
import assert from "node:assert/strict";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";

test("long setup passes only when both user-defined 4h conditions pass", () => {
  assert.equal(isLongSetup({ close: 110, ema500: 100, cci1200: 101 }), true);
  assert.equal(isLongSetup({ close: 100, ema500: 100, cci1200: 101 }), false);
  assert.equal(isLongSetup({ close: 110, ema500: 100, cci1200: 100 }), false);
  assert.equal(isLongSetup({ close: 90, ema500: 100, cci1200: 150 }), false);
  assert.equal(isLongSetup({ close: 110, ema500: 100, cci1200: 90 }), false);
});

test("long setup rejects missing or non-finite indicator values", () => {
  assert.equal(isLongSetup({ close: 110, ema500: null, cci1200: 150 }), false);
  assert.equal(isLongSetup({ close: 110, ema500: 100, cci1200: NaN }), false);
});

test("only closed 4h candles are retained", () => {
  const now = 20 * 60 * 60 * 1000;
  const bars = [
    { timestamp: now - 8 * 60 * 60 * 1000, confirmed: null },
    { timestamp: now - 2 * 60 * 60 * 1000, confirmed: null },
    { timestamp: now - 1 * 60 * 60 * 1000, confirmed: true },
    { timestamp: now - 9 * 60 * 60 * 1000, confirmed: false }
  ];
  assert.equal(keepClosedFourHourCandles(bars, now).length, 2);
});

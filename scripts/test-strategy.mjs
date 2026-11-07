import test from "node:test";
import assert from "node:assert/strict";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";

test("4h long condition uses CCI1000 > 100 without EMA filters", () => {
  assert.equal(isLongSetup({ cci1000: 100.01 }), true);
  assert.equal(isLongSetup({ cci1000: 100 }), false);
  assert.equal(isLongSetup({ cci1000: 99.99 }), false);
});

test("4h CCI condition rejects missing or non-finite values", () => {
  assert.equal(isLongSetup({ cci1000: null }), false);
  assert.equal(isLongSetup({ cci1000: NaN }), false);
  assert.equal(isLongSetup({}), false);
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

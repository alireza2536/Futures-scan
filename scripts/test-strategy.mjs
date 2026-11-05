import test from "node:test";
import assert from "node:assert/strict";
import {
  isLongSetup, isLongTimeframeSetup, isLongSetupForSelectedTimeframes,
  keepClosedFourHourCandles, keepClosedCandles
} from "./strategy.mjs";

test("4h long setup requires close above EMA500 and CCI above 100", () => {
  assert.equal(isLongSetup({ close: 101, ema500: 100, cci1200: 101 }), true);
  assert.equal(isLongSetup({ close: 100, ema500: 100, cci1200: 101 }), false);
  assert.equal(isLongSetup({ close: 101, ema500: 100, cci1200: 100 }), false);
});

test("2h and 1h require close above EMA2000 and CCI above 100", () => {
  for (const timeframe of ["1h", "2h"]) {
    assert.equal(isLongTimeframeSetup(timeframe, { close: 101, ema2000: 100, cci1200: 101 }), true);
    assert.equal(isLongTimeframeSetup(timeframe, { close: 99, ema2000: 100, cci1200: 101 }), false);
    assert.equal(isLongTimeframeSetup(timeframe, { close: 101, ema2000: 100, cci1200: 100 }), false);
  }
});

test("15m requires CCI above 170 and EMA9 above VWAP and EMA21", () => {
  assert.equal(isLongTimeframeSetup("15m", { cci1200: 171, ema9: 12, vwap: 10, ema21: 11 }), true);
  assert.equal(isLongTimeframeSetup("15m", { cci1200: 170, ema9: 12, vwap: 10, ema21: 11 }), false);
  assert.equal(isLongTimeframeSetup("15m", { cci1200: 171, ema9: 10, vwap: 11, ema21: 9 }), false);
});

test("daily requires close above EMA20 and EMA50", () => {
  assert.equal(isLongTimeframeSetup("1d", { close: 101, ema20: 99, ema50: 100 }), true);
  assert.equal(isLongTimeframeSetup("1d", { close: 101, ema20: 102, ema50: 100 }), false);
});

test("selected timeframes combine with AND, not OR", () => {
  const values = {
    "4h": { close: 101, ema500: 100, cci1200: 101 },
    "1d": { close: 101, ema20: 99, ema50: 100 }
  };
  assert.equal(isLongSetupForSelectedTimeframes(values, ["4h", "1d"]), true);
  values["1d"].close = 99;
  assert.equal(isLongSetupForSelectedTimeframes(values, ["4h", "1d"]), false);
  assert.equal(isLongSetupForSelectedTimeframes(values, ["4h"]), true);
});

test("closed candle filtering uses the selected timeframe duration", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const bars = [
    { timestamp: now - 2 * 60 * 60 * 1000, confirmed: null },
    { timestamp: now - 30 * 60 * 1000, confirmed: null },
    { timestamp: now - 1 * 60 * 60 * 1000, confirmed: false },
    { timestamp: now - 1 * 60 * 60 * 1000, confirmed: true }
  ];
  assert.equal(keepClosedCandles(bars, "15m", now).length, 3);
  assert.equal(keepClosedCandles(bars, "1h", now).length, 2);
  assert.equal(keepClosedFourHourCandles(bars, now).length, 1);
});

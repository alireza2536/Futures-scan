import test from "node:test";
import assert from "node:assert/strict";
import { filterInitialUniverse, initialEntryDecision, normalizeBaseAsset } from "./initial-filter.mjs";

test("USD stablecoins are rejected before data retrieval", () => {
  for (const base of ["USDT", "USDC", "DAI", "USDE", "USD1", "PYUSD", "RLUSD", "FRAX", "CRVUSD", "USDC.E", "USDTB"]) {
    assert.equal(initialEntryDecision(base, 1).reason, "USD_STABLECOIN", base);
  }
});

test("price above 30 is rejected", () => {
  assert.equal(initialEntryDecision("BTC", 30.00001).allowed, false);
  assert.equal(initialEntryDecision("BTC", 30.00001).reason, "PRICE_ABOVE_30_USDT");
});

test("price exactly 30 and below are allowed", () => {
  assert.equal(initialEntryDecision("ALT", 30).allowed, true);
  assert.equal(initialEntryDecision("ALT", 0.001).allowed, true);
});

test("missing or invalid price fails closed", () => {
  assert.equal(initialEntryDecision("ALT", null).reason, "PRICE_UNAVAILABLE");
  assert.equal(initialEntryDecision("ALT", 0).reason, "PRICE_UNAVAILABLE");
});

test("multiplier-prefixed stablecoin aliases are normalized", () => {
  assert.equal(normalizeBaseAsset("1000USDT"), "USDT");
  assert.equal(initialEntryDecision("1000USDT", 1000).reason, "USD_STABLECOIN");
});

test("universe gate only passes symbols with both conditions satisfied", () => {
  const markets = [
    { symbol: "A_USDT", baseAsset: "A" },
    { symbol: "USDC_USDT", baseAsset: "USDC" },
    { symbol: "B_USDT", baseAsset: "B" },
    { symbol: "C_USDT", baseAsset: "C" }
  ];
  const tickers = new Map([["A_USDT", 30], ["USDC_USDT", 1], ["B_USDT", 30.01]]);
  const result = filterInitialUniverse(markets, tickers);
  assert.deepEqual(result.allowed.map(x => x.symbol), ["A_USDT"]);
  assert.equal(result.counts.stablecoin, 1);
  assert.equal(result.counts.abovePrice, 1);
  assert.equal(result.counts.priceUnavailable, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEntryEligibility } from "./entry-filters.mjs";

test("excludes stablecoin base assets", () => {
  assert.deepEqual(evaluateEntryEligibility({ baseAsset: "USDC", lastPrice: 1 }), {
    eligible: false, reason: "STABLECOIN_BASE"
  });
});

test("accepts a non-stablecoin priced exactly at 30 USD", () => {
  assert.equal(evaluateEntryEligibility({ baseAsset: "BR", lastPrice: 30 }).eligible, true);
});

test("accepts a non-stablecoin below 30 USD", () => {
  assert.equal(evaluateEntryEligibility({ baseAsset: "ADA", lastPrice: 0.5 }).eligible, true);
});

test("rejects a non-stablecoin above 30 USD", () => {
  assert.deepEqual(evaluateEntryEligibility({ baseAsset: "BTC", lastPrice: 30.01 }), {
    eligible: false, reason: "PRICE_ABOVE_30_USD"
  });
});

test("rejects missing or invalid prices instead of admitting the symbol", () => {
  assert.equal(evaluateEntryEligibility({ baseAsset: "ADA", lastPrice: null }).reason,
    "INVALID_OR_MISSING_PRICE");
});

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

test("excludes known commodity underlyings", () => {
  for (const baseAsset of ["XAU", "USOIL", "TUNGSTEN"]) {
    assert.deepEqual(evaluateEntryEligibility({ baseAsset, lastPrice: 10 }), {
      eligible: false, reason: "NON_CRYPTO_UNDERLYING"
    });
  }
});

test("excludes tokenized equities and equity indices", () => {
  for (const baseAsset of ["ANTHROPIC", "APPSTOCK", "NIO", "LUXSHARE", "SINOCERA", "CCTC", "JP225"]) {
    assert.deepEqual(evaluateEntryEligibility({ baseAsset, lastPrice: 10 }), {
      eligible: false, reason: "NON_CRYPTO_UNDERLYING"
    });
  }
});

test("excludes exchange synthetic FX and index identifiers", () => {
  for (const baseAsset of ["NCSINIFTYBK2USD", "NCFXUSD2TWD", "EURUSD", "USDJPY"]) {
    assert.deepEqual(evaluateEntryEligibility({ baseAsset, lastPrice: 10 }), {
      eligible: false, reason: "NON_CRYPTO_UNDERLYING"
    });
  }
});

test("does not classify ambiguous GAS base as non-crypto without market metadata", () => {
  assert.equal(evaluateEntryEligibility({ baseAsset: "GAS", lastPrice: 10 }).eligible, true);
});

test("does not classify six-letter crypto tickers as FX unless both halves are fiat codes", () => {
  assert.equal(evaluateEntryEligibility({ baseAsset: "ABCUSD", lastPrice: 10 }).eligible, true);
});

test("continues to admit ordinary crypto assets under the price ceiling", () => {
  for (const baseAsset of ["BTC", "ETH", "ADA", "BR", "DOGE"]) {
    assert.equal(evaluateEntryEligibility({ baseAsset, lastPrice: 10 }).eligible, true);
  }
});

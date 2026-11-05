import test from "node:test";
import assert from "node:assert/strict";
import { buildUniqueAssetList, canonicalAssetId } from "./unique-assets.mjs";

test("same underlying asset across exchanges appears once and retains each result", () => {
  const rows = [
    { exchange: "OKX", symbol: "BTC-USDT-SWAP", baseAsset: "BTC", status: "LONG" },
    { exchange: "MEXC", symbol: "BTC_USDT", baseAsset: "BTC", status: "NO_MATCH" },
    { exchange: "BingX", symbol: "BTC-USDT", baseAsset: "BTC", status: "LONG" },
    { exchange: "OKX", symbol: "ETH-USDT-SWAP", baseAsset: "ETH", status: "NO_MATCH" }
  ];
  const unique = buildUniqueAssetList(rows);
  assert.equal(unique.length, 2);
  const btc = unique.find(item => item.baseAsset === "BTC");
  assert.deepEqual(btc.exchanges, ["BINGX", "MEXC", "OKX"]);
  assert.deepEqual(btc.qualifiedExchanges, ["BINGX", "OKX"]);
  assert.equal(btc.contractResults.length, 3);
});

test("multiplier aliases normalize to the same underlying asset", () => {
  assert.equal(
    canonicalAssetId({ baseAsset: "1000SHIB", exchange: "OKX", symbol: "1000SHIB-USDT-SWAP" }),
    canonicalAssetId({ baseAsset: "SHIB", exchange: "MEXC", symbol: "SHIB_USDT" })
  );
});

test("missing base metadata does not merge unrelated exchange contracts", () => {
  assert.notEqual(
    canonicalAssetId({ exchange: "OKX", symbol: "UNKNOWN-USDT-SWAP" }),
    canonicalAssetId({ exchange: "MEXC", symbol: "UNKNOWN_USDT" })
  );
});

test("non-matching and data-error exchange results are retained", () => {
  const unique = buildUniqueAssetList([
    { exchange: "OKX", symbol: "X-USDT-SWAP", baseAsset: "X", status: "DATA_ERROR" },
    { exchange: "MEXC", symbol: "X_USDT", baseAsset: "X", status: "NO_MATCH" }
  ]);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].contractResults.length, 2);
  assert.deepEqual(unique[0].qualifiedExchanges, []);
});

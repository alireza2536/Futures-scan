import test from "node:test";
import assert from "node:assert/strict";
import { persistScanResults, loadDailyCCIState, saveDailyCCIState } from "./persist-neon.mjs";

test("Neon persistence module exposes one valid set of persistence functions", () => {
  assert.equal(typeof persistScanResults, "function");
  assert.equal(typeof loadDailyCCIState, "function");
  assert.equal(typeof saveDailyCCIState, "function");
});

test("persistence safely reports missing DATABASE_URL without connecting", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const summary = {
      generatedAt: new Date(0).toISOString(),
      exchanges: ["OKX"],
      scanned: 1,
      dataReady: 1,
      partialData: 0,
      dataErrors: 0
    };
    assert.deepEqual(await persistScanResults(summary), { status: "SKIPPED_NO_DATABASE_URL" });
    assert.equal(await loadDailyCCIState("OKX", "BTC-USDT-SWAP"), null);
    assert.deepEqual(await saveDailyCCIState("OKX", "BTC-USDT-SWAP", {
      lastTimestamp: 1, typicalPrices: [], recentCandles: []
    }), { status: "SKIPPED_NO_DATABASE_URL" });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

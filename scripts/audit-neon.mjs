import { writeFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL secret is missing");
const sql = neon(url);
const rows = await sql`
  SELECT id::text AS id, generated_at,
         jsonb_typeof(payload) AS payload_type,
         jsonb_typeof(payload->'results') AS results_type,
         jsonb_typeof(payload->'rejected') AS rejected_type,
         COALESCE(jsonb_array_length(payload->'results'), 0) AS results_count,
         COALESCE(jsonb_array_length(payload->'rejected'), 0) AS rejected_count,
         payload->'results' AS results,
         payload->'rejected' AS rejected
  FROM futures_scan_snapshots
  ORDER BY generated_at ASC
`;

const stablecoins = new Set([
  "USDT","USDC","USDE","USDS","DAI","FDUSD","TUSD","BUSD","USDP","PYUSD","GUSD",
  "USD1","FRAX","USDD","UST","USTC","EURC","EURS","EURA","EURI","USDX","USDX",
  "USDTB","USDC.E","USDC.e","USX","USN","USDK","USDX","USDR","USDS","USDB",
  "USDT0","USDC0","USDCN","USDJ","USDP","USDF","USDL","USDL","USDM","USDA"
]);
const matches = [];
const assets = new Map();
const shapes = [];
for (const row of rows) {
  shapes.push({
    id: row.id, generatedAt: row.generated_at, payloadType: row.payload_type,
    resultsType: row.results_type, rejectedType: row.rejected_type,
    resultsCount: Number(row.results_count), rejectedCount: Number(row.rejected_count)
  });
  for (const [arrayName, items] of [["results", row.results], ["rejected", row.rejected]]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const baseAsset = String(item?.baseAsset ?? "").trim().toUpperCase();
      const symbol = String(item?.symbol ?? "");
      const price = Number(item?.lastPriceUsd);
      const stablecoin = stablecoins.has(baseAsset);
      const over30 = Number.isFinite(price) && price > 30;
      const bitcoin = baseAsset === "BTC" || /(^|[-_])BTC([-_]|$)/i.test(symbol);
      if (baseAsset) {
        const prev = assets.get(baseAsset) ?? { baseAsset, occurrences: 0, maxObservedPriceUsd: null, exchanges: new Set() };
        prev.occurrences++;
        if (Number.isFinite(price)) prev.maxObservedPriceUsd = prev.maxObservedPriceUsd === null ? price : Math.max(prev.maxObservedPriceUsd, price);
        if (item?.exchange) prev.exchanges.add(item.exchange);
        assets.set(baseAsset, prev);
      }
      if (stablecoin || over30 || bitcoin) {
        matches.push({
          snapshotId: row.id, generatedAt: row.generated_at, array: arrayName,
          exchange: item?.exchange ?? null, symbol, baseAsset: baseAsset || null,
          lastPriceUsd: Number.isFinite(price) ? price : null,
          reasons: [stablecoin ? "STABLECOIN_BASE" : null, over30 ? "PRICE_ABOVE_30_USD" : null, bitcoin ? "BTC_ALWAYS_EXCLUDE" : null].filter(Boolean)
        });
      }
    }
  }
}
const report = {
  generatedAt: new Date().toISOString(),
  snapshotCount: rows.length,
  snapshotShapes: shapes,
  uniqueBaseAssets: [...assets.values()].map(x => ({...x, exchanges: [...x.exchanges]})).sort((a,b)=>a.baseAsset.localeCompare(b.baseAsset)),
  candidateEntriesForRemoval: matches,
  candidateEntryCount: matches.length,
  note: "READ ONLY. No database rows or JSON values were modified. Review all uniqueBaseAssets for stablecoins not in the explicit classification list before deletion."
};
await writeFile("neon-audit-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  snapshotCount: report.snapshotCount,
  uniqueBaseAssetCount: report.uniqueBaseAssets.length,
  candidateEntryCount: report.candidateEntryCount,
  candidateBaseAssets: [...new Set(matches.map(x => x.baseAsset).filter(Boolean))].sort(),
  reportFile: "neon-audit-report.json"
}, null, 2));

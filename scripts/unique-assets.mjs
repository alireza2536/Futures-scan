import { normalizeBaseAsset } from "./initial-filter.mjs";

/**
 * Build a display-level unique asset list without discarding exchange-level
 * contract results. Asset identity is conservative: normalized base-asset
 * metadata is preferred; if absent, the contract stays exchange-scoped.
 */
export function canonicalAssetId(result) {
  const base = normalizeBaseAsset(result?.baseAsset ?? "");
  if (base) return `BASE:${base}`;
  return `CONTRACT:${String(result?.exchange ?? "UNKNOWN").toUpperCase()}:${String(result?.symbol ?? "")}`;
}

export function buildUniqueAssetList(contractResults) {
  const groups = new Map();

  for (const result of contractResults ?? []) {
    const assetId = canonicalAssetId(result);
    if (!groups.has(assetId)) {
      groups.set(assetId, {
        assetId,
        baseAsset: assetId.startsWith("BASE:") ? assetId.slice(5) : null,
        exchanges: [],
        qualifiedExchanges: [],
        contractResults: []
      });
    }

    const group = groups.get(assetId);
    group.contractResults.push(result);

    const exchange = String(result?.exchange ?? "UNKNOWN").toUpperCase();
    if (!group.exchanges.includes(exchange)) group.exchanges.push(exchange);
    if (result?.status === "LONG" && !group.qualifiedExchanges.includes(exchange)) {
      group.qualifiedExchanges.push(exchange);
    }
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      exchanges: group.exchanges.sort(),
      qualifiedExchanges: group.qualifiedExchanges.sort(),
      contractResults: group.contractResults.sort((a, b) =>
        String(a.exchange).localeCompare(String(b.exchange)) ||
        String(a.symbol).localeCompare(String(b.symbol))
      )
    }))
    .sort((a, b) => String(a.baseAsset ?? a.assetId).localeCompare(String(b.baseAsset ?? b.assetId)));
}

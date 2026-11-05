// Entry-universe filters. These are not long/short trading rules.
export const MAX_ENTRY_PRICE_USD = 30;

// Exclude USD-pegged stablecoin base assets from the futures universe.
// Keep this list explicit and easy to review as new stablecoins appear.
export const STABLECOIN_BASES = new Set([
  "USDT", "USDC", "USDE", "USDS", "DAI", "FDUSD", "TUSD", "BUSD",
  "USDP", "PYUSD", "GUSD", "USD1", "FRAX", "USDD", "UST", "USTC",
  "EURC", "EURS", "EURA", "EURI", "USDX", "USDX"
]);

export function normalizeBaseAsset(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function isStablecoinBase(value) {
  return STABLECOIN_BASES.has(normalizeBaseAsset(value));
}

export function evaluateEntryEligibility({ baseAsset, lastPrice }) {
  const base = normalizeBaseAsset(baseAsset);
  const price = Number(lastPrice);

  if (!base) return { eligible: false, reason: "MISSING_BASE_ASSET" };
  if (isStablecoinBase(base)) return { eligible: false, reason: "STABLECOIN_BASE" };
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, reason: "INVALID_OR_MISSING_PRICE" };
  }
  if (price > MAX_ENTRY_PRICE_USD) {
    return { eligible: false, reason: "PRICE_ABOVE_30_USD" };
  }
  return { eligible: true, reason: "ELIGIBLE", price };
}

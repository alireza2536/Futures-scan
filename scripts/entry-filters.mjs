// Entry-universe filters. These are not long/short trading rules.
export const MAX_ENTRY_PRICE_USD = 30;

// USD-pegged stablecoin base assets are excluded from the futures universe.
export const STABLECOIN_BASES = new Set([
  "USDT", "USDC", "USDE", "USDS", "DAI", "FDUSD", "TUSD", "BUSD",
  "USDP", "PYUSD", "GUSD", "USD1", "FRAX", "USDD", "UST", "USTC",
  "EURC", "EURS", "EURA", "EURI", "USDX"
]);

// Known non-cryptocurrency underlyings seen in exchange perpetual catalogs.
// This intentionally excludes tokenized equities, indices, FX pairs and commodities.
export const NON_CRYPTO_BASES = new Set([
  // Precious metals and commodities
  "XAU", "XAG", "XPT", "XPD", "USOIL", "UKOIL", "WTI", "BRENT",
  "NATGAS", "GAS", "COPPER", "WHEAT", "CORN", "SOYBEAN", "TUNGSTEN",
  // Equity / tokenized-stock underlyings observed in the exchange catalogs
  "ANTHROPIC", "APPSTOCK", "NIO", "LUXSHARE", "SINOCERA", "CCTC",
  // Major equity-index contracts
  "JP225", "US30", "US500", "SPX", "NAS100", "US100", "GER40",
  "DE40", "UK100", "FRA40", "HK50", "AUS200"
]);

export function normalizeBaseAsset(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function isStablecoinBase(value) {
  return STABLECOIN_BASES.has(normalizeBaseAsset(value));
}

export function isNonCryptoBase(value) {
  const base = normalizeBaseAsset(value);
  if (!base) return false;
  if (NON_CRYPTO_BASES.has(base)) return true;
  // Exchange-specific synthetic market identifiers for indices and FX.
  if (/^(?:NCS|NCFX|NCCO|NCCX)[A-Z0-9]+$/.test(base)) return true;
  if (/^(?:[A-Z]{3})[A-Z]{3}$/.test(base) && /(?:USD|EUR|JPY|GBP|CHF|AUD|CAD|CNY|INR|TWD)$/.test(base)) return true;
  return false;
}

export function evaluateEntryEligibility({ baseAsset, lastPrice }) {
  const base = normalizeBaseAsset(baseAsset);
  const price = Number(lastPrice);

  if (!base) return { eligible: false, reason: "MISSING_BASE_ASSET" };
  if (isStablecoinBase(base)) return { eligible: false, reason: "STABLECOIN_BASE" };
  if (isNonCryptoBase(base)) return { eligible: false, reason: "NON_CRYPTO_UNDERLYING" };
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, reason: "INVALID_OR_MISSING_PRICE" };
  }
  if (price > MAX_ENTRY_PRICE_USD) {
    return { eligible: false, reason: "PRICE_ABOVE_30_USD" };
  }
  return { eligible: true, reason: "ELIGIBLE", price };
}

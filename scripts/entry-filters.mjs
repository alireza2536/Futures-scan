// Entry-universe filters. These are not long/short trading rules.
export const MAX_ENTRY_PRICE_USD = 30;

// USD-pegged stablecoin base assets are excluded from the futures universe.
export const STABLECOIN_BASES = new Set([
  "USDT", "USDC", "USDE", "USDS", "DAI", "FDUSD", "TUSD", "BUSD",
  "USDP", "PYUSD", "GUSD", "USD1", "FRAX", "USDD", "UST", "USTC",
  "EURC", "EURS", "EURA", "EURI", "USDX", "USDK", "USDB", "USDA", "USDJ", "USDH", "USN", "USX", "USDM", "USDL", "USDY", "USDR", "USDT0" , "USDC.E", "USDCN"
]);

// Known non-cryptocurrency underlyings seen in exchange perpetual catalogs.
// This intentionally excludes tokenized equities, indices, FX pairs and commodities.
export const NON_CRYPTO_BASES = new Set([
  // Precious metals and commodities
  "XAU", "XAG", "XPT", "XPD", "USOIL", "UKOIL", "WTI", "BRENT",
  "NATGAS", "COPPER", "WHEAT", "CORN", "SOYBEAN", "TUNGSTEN",
  // Equity / tokenized-stock underlyings observed in the exchange catalogs
  "ANTHROPIC", "APPSTOCK", "NIO", "LUXSHARE", "SINOCERA", "CCTC", "BITO",
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
  if (NON_CRYPTO_BASES.has(base) || base.endsWith("STOCK")) return true;
  if (/^(?:NCS|NCFX|NCCO|NCCX)[A-Z0-9]+$/.test(base)) return true;
  const fiatCodes = new Set(["USD","EUR","JPY","GBP","CHF","AUD","CAD","CNY","INR","TWD","HKD","SGD","NZD","KRW","TRY","RUB","BRL","MXN","ZAR","SEK","NOK","DKK","PLN","CZK","HUF","ILS","AED","SAR","THB","IDR","MYR","PHP","VND","PKR","BDT","KWD","QAR","EGP","ARS","CLP","COP"]);
  if (/^[A-Z]{6}$/.test(base) && fiatCodes.has(base.slice(0,3)) && fiatCodes.has(base.slice(3,6))) return true;
  return false;
}

export function isNonCryptoMarket({ baseAsset, marketInfo } = {}) {
  if (isNonCryptoBase(baseAsset)) return true;
  if (!marketInfo || typeof marketInfo !== "object") return false;
  const keys = ["displayNameEn","displayName","enName","businessName","description","enDesc","enRemark","assetClass","marketType","underlyingType","underlyingSubType","productType","category","tags"];
  const values = [];
  for (const key of keys) {
    const value = marketInfo[key];
    if (Array.isArray(value)) values.push(...value.filter(v => typeof v === "string"));
    else if (typeof value === "string") values.push(value);
  }
  return values.some(value => /\b(?:stock|equity|equities|etf|forex|foreign exchange|fx pair|index|indices|commodity|commodities|gold|silver|crude oil|natural gas)\b|股票|股指/i.test(value));
}

export function evaluateEntryEligibility({ baseAsset, lastPrice, marketInfo }) {
  const base = normalizeBaseAsset(baseAsset);
  const price = Number(lastPrice);

  if (!base) return { eligible: false, reason: "MISSING_BASE_ASSET" };
  if (isStablecoinBase(base)) return { eligible: false, reason: "STABLECOIN_BASE" };
  if (isNonCryptoMarket({ baseAsset: base, marketInfo })) return { eligible: false, reason: "NON_CRYPTO_UNDERLYING" };
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, reason: "INVALID_OR_MISSING_PRICE" };
  }
  if (price > MAX_ENTRY_PRICE_USD) {
    return { eligible: false, reason: "PRICE_ABOVE_30_USD" };
  }
  return { eligible: true, reason: "ELIGIBLE", price };
}

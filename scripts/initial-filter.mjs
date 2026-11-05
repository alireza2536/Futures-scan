const USD_STABLECOIN_BASES = new Set([
  "USDT", "USDC", "USDE", "USDS", "USDD", "USDP", "DAI", "USD1", "USDG",
  "PYUSD", "RLUSD", "FDUSD", "TUSD", "GUSD", "GHO", "USDF", "USDT0",
  "BUSD", "UST", "USTC", "FRAX", "CRVUSD", "MIM", "LUSD", "SUSD",
  "DOLA", "ALUSD", "FEI", "EUSD", "USDK", "USDJ", "USN", "USDX",
  "USD0", "USDB", "USDA", "USDH", "USDL", "USDQ", "USDZ", "USX",
  "USDC.E", "USDT.E", "USDCN", "USDTB", "USDR", "USDT+", "USDC+", "USDCV",
  "AUSD", "USR", "USDY", "USYC", "USDM", "USDV", "USDO", "USDN", "USDAI", "USDFI", "USDSC"
]);

function rawBaseAsset(value) {
  return String(value ?? "").trim().toUpperCase();
}

function priceDivisor(baseAsset, contractSymbol = "") {
  const symbolBase = String(contractSymbol ?? "").trim().toUpperCase().split(/[\/_-]/)[0];
  const candidates = [rawBaseAsset(baseAsset), symbolBase];
  for (const candidate of candidates) {
    for (const multiplier of ["1000000", "100000", "10000", "1000"]) {
      if (candidate.startsWith(multiplier) && candidate.length > multiplier.length) {
        return Number(multiplier);
      }
    }
  }
  return 1;
}

export function isUsdStablecoinBase(value) {
  return USD_STABLECOIN_BASES.has(normalizeBaseAsset(value));
}

export function normalizeBaseAsset(value) {
  let base = rawBaseAsset(value);
  for (const multiplier of ["1000000", "100000", "10000", "1000"]) {
    if (base.startsWith(multiplier) && base.length > multiplier.length) {
      base = base.slice(multiplier.length);
      break;
    }
  }
  return base;
}

export function initialEntryDecision(baseAsset, price, maxPrice = 30, contractSymbol = "") {
  const base = normalizeBaseAsset(baseAsset || contractSymbol);
  if (USD_STABLECOIN_BASES.has(base)) {
    return { allowed: false, reason: "USD_STABLECOIN", price: null };
  }
  const last = Number(price);
  if (!Number.isFinite(last) || last <= 0) {
    return { allowed: false, reason: "PRICE_UNAVAILABLE", price: null };
  }
  const underlyingPrice = last / priceDivisor(baseAsset, contractSymbol);
  if (underlyingPrice > maxPrice) {
    return { allowed: false, reason: "PRICE_ABOVE_30_USDT", price: underlyingPrice };
  }
  return { allowed: true, reason: "ALLOWED", price: underlyingPrice };
}

export function filterInitialUniverse(markets, tickerMap, maxPrice = 30) {
  const result = { allowed: [], rejected: [], counts: {
    candidates: markets.length, allowed: 0, stablecoin: 0, abovePrice: 0, priceUnavailable: 0
  }};
  for (const market of markets) {
    const decision = initialEntryDecision(market.baseAsset, tickerMap.get(market.symbol), maxPrice, market.symbol);
    if (decision.allowed) {
      result.allowed.push({ ...market, initialPrice: decision.price });
      result.counts.allowed += 1;
    } else {
      result.rejected.push({ ...market, reason: decision.reason, initialPrice: decision.price });
      if (decision.reason === "USD_STABLECOIN") result.counts.stablecoin += 1;
      else if (decision.reason === "PRICE_ABOVE_30_USDT") result.counts.abovePrice += 1;
      else result.counts.priceUnavailable += 1;
    }
  }
  return result;
}

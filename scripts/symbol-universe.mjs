const TIMEOUT_MS = 25000;

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.5" },
        signal: controller.signal
      });
      const body = await response.json();
      const apiCode = Number(body?.code ?? body?.returnCode);
      const transient = response.status === 429 || [100410, 100429].includes(apiCode) || apiCode === 510;
      if (transient) {
        if (attempt === 3) throw new Error(`Transient API limit from ${url}: ${apiCode || response.status}`);
        await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 180)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Public API request failed");
}

function isExplicitTradFiContract(row) {
  const fields = [
    row?.assetClass, row?.asset_class, row?.assetType, row?.asset_type,
    row?.baseAssetType, row?.baseAssetSubType, row?.base_asset_type, row?.base_asset_sub_type,
    row?.marketType, row?.market_type, row?.businessType, row?.business_type,
    row?.productType, row?.product_type, row?.category, row?.symbolType,
    row?.symbol_type, row?.instrumentType, row?.instrument_type,
    row?.underlyingType, row?.underlying_type
  ];
  const normalized = fields.filter(value => value !== null && value !== undefined && String(value).trim() !== "")
    .map(value => String(value).trim().toLowerCase().replace(/[\\s_-]+/g, ""));
  const names = [
    row?.baseCoinName, row?.baseCoinNameEn, row?.enName, row?.enDesc,
    row?.cnName, row?.cnDesc, row?.displayName, row?.description
  ].filter(value => value !== null && value !== undefined && String(value).trim() !== "")
    .map(value => String(value).trim().toLowerCase());
  return normalized.some(value =>
    /^(tradfi|traditionalfinance|stock|stocks|equity|equities|forex|fx|commodity|commodities|index|indices|metal|metals|energy)$/.test(value)
  ) || names.some(value =>
    /(stock|equity|share|forex|commodity|commodities|indices|index|metal|metals|gold|silver|crude|oil|natural gas|sp500|s&p|nasdaq|dow jones|nikkei|jp225|us30)/i.test(value)
  );
}

function hasHtxOfficialTradFiLabel(row) {
  const labels = [
    ...(Array.isArray(row?.labels) ? row.labels : []),
    ...(Array.isArray(row?.tradfi_labels) ? row.tradfi_labels : [])
  ].map(value => String(value ?? "").trim().toLowerCase().replace(/[\\s_-]+/g, ""));
  return labels.some(value =>
    /^(tradfi|traditionalfinance|stock|stocks|equity|equities|forex|fx|commodity|commodities|index|indices|metal|metals|energy|etf|preipo)$/.test(value)
  );
}

function isBingXTradFiSymbol(symbol) {
  const base = String(symbol ?? "").split("-")[0].toUpperCase();
  return /^(NCS|NCCO|NCF)/.test(base);
}

function usdtSymbol(exchange, symbol) {
  if (typeof symbol !== "string") return false;
  if (exchange === "BINGX") return symbol.endsWith("-USDT");
  if (exchange === "WEEX") return symbol.toUpperCase().endsWith("USDT");
  if (exchange === "HTX") return symbol.endsWith("-USDT");
  if (exchange === "KUCOIN") return symbol.toUpperCase().endsWith("USDTM");
  if (exchange === "XT") return symbol.toLowerCase().endsWith("_usdt");
  return false;
}

function normalizeMarketKey(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function mapOfficialSymbolsToCcxt(exchange, client, officialRows, symbolOf, baseOf) {
  const markets = await client.loadMarkets();
  const byKey = new Map();
  for (const market of Object.values(markets)) {
    if (!market || market.active === false || market.contract !== true || market.swap !== true ||
        market.quote !== "USDT" || market.settle !== "USDT" || !market.symbol || !market.base) continue;
    const keys = [market.id, market.symbol, String(market.symbol).split(":")[0], `${market.base}${market.quote}`];
    for (const key of keys) {
      const normalized = normalizeMarketKey(key);
      if (normalized && !byKey.has(normalized)) byKey.set(normalized, market);
    }
  }
  const output = [];
  const missing = [];
  for (const row of officialRows) {
    const officialSymbol = String(symbolOf(row) ?? "");
    const market = byKey.get(normalizeMarketKey(officialSymbol));
    if (!market) { missing.push(officialSymbol); continue; }
    output.push({
      exchange,
      symbol: market.symbol,
      display: officialSymbol,
      base: market.base || baseOf?.(row) || null,
      marketId: market.id
    });
  }
  if (missing.length) {
    throw new Error(`${exchange} official crypto catalog has ${missing.length} symbol(s) without a matching active CCXT market: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "…" : ""}`);
  }
  return output;
}

async function getMexcSymbols() {
  const payload = await getJson("https://api.mexc.com/api/v1/contract/detail");
  if (!(payload?.success === true || payload?.code === 0) || !Array.isArray(payload?.data)) {
    throw new Error("MEXC contract catalog schema/status check failed");
  }
  const rows = payload.data.filter(row =>
    Number(row?.state) === 0 &&
    String(row?.settleCoin ?? "").toUpperCase() === "USDT" &&
    usdtSymbol("MEXC", row?.symbol) &&
    Number(row?.typeLabel) === 0 &&
    !isExplicitTradFiContract(row)
  );
  if (!rows.length) throw new Error("MEXC returned no officially crypto-classified active USDT perpetuals");
  return rows.map(row => ({
    exchange: "MEXC", symbol: row.symbol, display: row.symbol,
    base: row.baseCoin, marketId: row.symbol
  }));
}

async function getOkxSymbols() {
  let lastError;
  for (const base of ["https://eea.okx.com", "https://openapi.okx.com"]) {
    try {
      const payload = await getJson(base + "/api/v5/public/instruments?instType=SWAP");
      if (String(payload?.code) !== "0" || !Array.isArray(payload?.data)) {
        throw new Error("OKX SWAP instrument catalog schema/status check failed");
      }
      const rows = payload.data.filter(row =>
        row?.state === "live" &&
        String(row?.settleCcy ?? "").toUpperCase() === "USDT" &&
        String(row?.instCategory) === "1"
      );
      if (!rows.length) throw new Error("OKX returned no instruments explicitly classified as crypto");
      return rows.map(row => ({
        exchange: "OKX", symbol: row.instId, display: row.instId,
        base: row.ctValCcy || String(row.instId).split("-")[0],
        apiBase: base, marketId: row.instId
      }));
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("OKX crypto USDT SWAP catalog unavailable");
}

async function getBingxSymbols(client) {
  const payload = await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/contracts");
  if (!(payload?.code === 0 || payload?.code === "0") || !Array.isArray(payload?.data)) {
    throw new Error("BingX contract catalog schema/status check failed");
  }
  const rows = payload.data.filter(row => {
    if (!usdtSymbol("BINGX", row?.symbol) || isExplicitTradFiContract(row) || isBingXTradFiSymbol(row?.symbol)) return false;
    const status = String(row?.status ?? "").toUpperCase();
    return !status || ["TRADING", "ACTIVE", "ONLINE", "1"].includes(status);
  });
  if (!rows.length) throw new Error("BingX returned no active crypto USDT perpetuals after official TradFi exclusions");
  return mapOfficialSymbolsToCcxt("BINGX", client, rows, row => row.symbol, row => row.asset);
}

async function getWeexSymbols() {
  const [perpetualCatalog, tradfiCatalog, apiTradingSymbols] = await Promise.all([
    getJson("https://api-contract.weex.com/capi/v3/market/exchangeInfo?contractType=PERPETUAL"),
    getJson("https://api-contract.weex.com/capi/v3/market/exchangeInfo?contractType=TRADIFI_PERPETUAL"),
    getJson("https://api-contract.weex.com/capi/v3/market/apiTradingSymbols")
  ]);
  if (!Array.isArray(perpetualCatalog?.symbols) || !Array.isArray(tradfiCatalog?.symbols) || !Array.isArray(apiTradingSymbols)) {
    throw new Error("WEEX contract/API-trading catalog schema check failed");
  }
  if (!apiTradingSymbols.length) throw new Error("WEEX API-trading catalog returned no symbols; refusing unverified universe");
  const tradfiSymbols = new Set(tradfiCatalog.symbols.map(row => String(row?.symbol ?? "").toUpperCase()).filter(Boolean));
  const cryptoCatalogSymbols = new Set(perpetualCatalog.symbols.filter(row => {
    const symbol = String(row?.symbol ?? "");
    const upper = symbol.toUpperCase();
    const status = String(row?.status ?? "").toUpperCase();
    return row?.contractType === "PERPETUAL" &&
      String(row?.underlyingType ?? "").toUpperCase() === "COIN" &&
      usdtSymbol("WEEX", symbol) &&
      !tradfiSymbols.has(upper) &&
      (!status || ["TRADING", "OPEN", "1"].includes(status)) &&
      String(row?.marginAsset ?? row?.quoteAsset ?? "USDT").toUpperCase() === "USDT";
  }).map(row => String(row.symbol).toUpperCase()));
  const apiTradableSet = new Set(apiTradingSymbols.map(value => {
    const upper = String(value).toUpperCase();
    const canonical = upper.replace(/SUSDT$/, "USDT");
    return cryptoCatalogSymbols.has(canonical) ? canonical : upper;
  }).filter(Boolean));
  const symbols = [...new Set(perpetualCatalog.symbols.filter(row => {
    const upper = String(row?.symbol ?? "").toUpperCase();
    return cryptoCatalogSymbols.has(upper) && apiTradableSet.has(upper);
  }).map(row => row.symbol))];
  const aliasApiMatches = [...cryptoCatalogSymbols].filter(symbol =>
    apiTradableSet.has(symbol) && !apiTradingSymbols.some(value => String(value).toUpperCase() === symbol)
  );
  console.log(JSON.stringify({
    event: "weex_crypto_universe",
    perpetualCatalogRows: perpetualCatalog.symbols.length,
    tradfiCatalogRows: tradfiCatalog.symbols.length,
    apiTradingSymbols: apiTradingSymbols.length,
    cryptoCatalog: cryptoCatalogSymbols.size,
    aliasApiMatches: aliasApiMatches.length,
    discoveredCryptoSymbols: symbols.length
  }));
  if (!symbols.length) throw new Error("WEEX returned no verified API-tradable crypto USDT perpetuals");
  return symbols.map(symbol => {
    const row = perpetualCatalog.symbols.find(item => String(item.symbol).toUpperCase() === String(symbol).toUpperCase());
    return {
      exchange: "WEEX", symbol, display: symbol,
      base: row?.baseAsset || String(symbol).replace(/USDT$/i, ""),
      marketId: symbol
    };
  });
}

async function getHtxSymbols() {
  const payload = await getJson("https://api.hbdm.com/linear-swap-api/v1/linear_swap_contract_info?business_type=all&trade_partition=CRYPTO");
  if (payload?.status !== "ok" || !Array.isArray(payload?.data)) {
    throw new Error("HTX official CRYPTO partition catalog schema/status check failed");
  }
  const rows = payload.data.filter(row =>
    Number(row?.contract_status) === 1 &&
    usdtSymbol("HTX", row?.contract_code) &&
    String(row?.settle_currency ?? row?.quote_currency ?? "USDT").toUpperCase() === "USDT" &&
    !hasHtxOfficialTradFiLabel(row) &&
    !isExplicitTradFiContract(row)
  );
  if (!rows.length) throw new Error("HTX returned no officially crypto-classified active USDT swaps");
  return rows.map(row => ({
    exchange: "HTX", symbol: row.contract_code, display: row.contract_code,
    base: row.symbol || String(row.contract_code).split("-")[0],
    marketId: row.contract_code
  }));
}

async function getKucoinSymbols(client) {
  const payload = await getJson("https://api-futures.kucoin.com/api/v1/contracts/active");
  if (String(payload?.code) !== "200000" || !Array.isArray(payload?.data)) {
    throw new Error("KuCoin official active-contract catalog schema/status check failed");
  }
  const rows = payload.data.filter(row => {
    const categories = [row?.marketType, row?.assetClass]
      .filter(value => value !== null && value !== undefined && String(value).trim() !== "")
      .map(value => String(value).toUpperCase());
    return categories.length > 0 &&
      categories.every(category => category === "CRYPTO") &&
      String(row?.quoteCurrency ?? "").toUpperCase() === "USDT" &&
      String(row?.settleCurrency ?? "").toUpperCase() === "USDT" &&
      usdtSymbol("KUCOIN", row?.symbol);
  });
  if (!rows.length) throw new Error("KuCoin returned no explicitly crypto-classified USDT-M contracts");
  return mapOfficialSymbolsToCcxt("KUCOIN", client, rows, row => row.symbol, row => row.baseCurrency);
}

async function getXtSymbols(client) {
  const [payload, platePayload] = await Promise.all([
    getJson("https://fapi.xt.com/future/market/v1/public/symbol/list"),
    getJson("https://fapi.xt.com/future/market/v1/public/plate/list")
  ]);
  if (payload?.returnCode !== 0 || !Array.isArray(payload?.result)) {
    throw new Error("XT official symbol catalog schema/status check failed");
  }
  if (platePayload?.returnCode !== 0 || !Array.isArray(platePayload?.result)) {
    throw new Error("XT official plate catalog schema/status check failed");
  }
  const tradfiPlates = platePayload.result.filter(row =>
    /^(tradfi|forex|tokenized stocks|commodities|index|indices|pre.?market)$/i.test(String(row?.plate ?? row?.name ?? "").trim())
  ).map(row => Number(row?.id)).filter(Number.isFinite);
  if (!tradfiPlates.length) throw new Error("XT official plate catalog has no recognized TradFi categories");
  const tradfiIds = new Set(tradfiPlates);
  const rows = payload.result.filter(row =>
    usdtSymbol("XT", row?.symbol) &&
    row?.tradeSwitch === true &&
    String(row?.settleCoin ?? row?.quoteCoin ?? "USDT").toUpperCase() === "USDT" &&
    Array.isArray(row?.plates) &&
    !row.plates.some(id => tradfiIds.has(Number(id))) &&
    !isExplicitTradFiContract(row)
  );
  if (!rows.length) throw new Error("XT returned no active USDT crypto contracts after official plate exclusions");
  return mapOfficialSymbolsToCcxt("XT", client, rows, row => row.symbol, row => row.baseCoin);
}

export async function loadExchangeUniverse(exchange, client = null) {
  switch (String(exchange).toUpperCase()) {
    case "MEXC": return getMexcSymbols();
    case "OKX": return getOkxSymbols();
    case "BINGX":
      if (!client) throw new Error("BingX CCXT client is required for OHLCV mapping");
      return getBingxSymbols(client);
    case "WEEX": return getWeexSymbols();
    case "HTX": return getHtxSymbols();
    case "KUCOIN":
      if (!client) throw new Error("KuCoin CCXT client is required for OHLCV mapping");
      return getKucoinSymbols(client);
    case "XT":
      if (!client) throw new Error("XT CCXT client is required for OHLCV mapping");
      return getXtSymbols(client);
    default: throw new Error("Unsupported exchange: " + exchange);
  }
}

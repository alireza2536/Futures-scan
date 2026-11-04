import { writeFile } from "node:fs/promises";

const TIMEOUT_MS = 25000;
async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan-universe-audit/1.0" },
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429 || body?.code === "50011") {
        if (attempt === 3) throw new Error(`Rate limit from ${url}`);
        await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body).slice(0, 180)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Request failed");
}
const unique = values => [...new Set(values.map(x => x == null ? "null" : JSON.stringify(x)))].sort();
const summarize = (rows, fields) => ({
  count: rows.length,
  fields: Object.fromEntries(fields.map(field => [field, unique(rows.map(row => row?.[field]))])),
  samples: rows.slice(0, 5)
});

const report = { generatedAt: new Date().toISOString(), venues: {} };

// MEXC official active USDT-margined perpetual contracts.
{
  const payload = await getJson("https://contract.mexc.com/api/v1/contract/detail");
  const rows = payload?.data;
  if (payload?.success !== true || !Array.isArray(rows)) throw new Error("MEXC contract detail response shape was not recognized");
  const candidate = rows.filter(x =>
    Number(x.state) === 0 &&
    String(x.quoteCoin).toUpperCase() === "USDT" &&
    String(x.settleCoin).toUpperCase() === "USDT" &&
    (x.futureType == null || Number(x.futureType) === 1)
  );
  const spotPayload = await getJson("https://api.mexc.com/api/v3/exchangeInfo");
  const spotRows = Array.isArray(spotPayload?.symbols) ? spotPayload.symbols : [];
  const spotBases = new Set(spotRows.filter(x => x.status === "1" || x.status === 1).map(x => String(x.baseAsset ?? "").toUpperCase()));
  const spotBacked = candidate.filter(x => spotBases.has(String(x.baseCoin ?? x.symbol?.split("_")[0] ?? "").toUpperCase()));
  report.venues.MEXC = {
    all: summarize(rows, ["symbol", "state", "quoteCoin", "settleCoin", "futureType"]),
    activeUsdtPerpetualCandidate: {
      ...summarize(candidate, ["symbol", "state", "quoteCoin", "settleCoin", "futureType"]),
      symbols: candidate.map(x => x.symbol),
      bases: candidate.map(x => String(x.baseCoin ?? x.symbol?.split("_")[0] ?? "").toUpperCase())
    },
    spotSymbolCount: spotRows.length,
    activeUsdtPerpetualsBackedBySpotBase: {
      ...summarize(spotBacked, ["symbol", "baseCoin"]),
      symbols: spotBacked.map(x => x.symbol),
      bases: spotBacked.map(x => String(x.baseCoin ?? x.symbol?.split("_")[0] ?? "").toUpperCase())
    }
  };
}

// OKX official active USDT-settled perpetual swaps.
{
  const payload = await getJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
  const rows = payload?.data;
  if (String(payload?.code) !== "0" || !Array.isArray(rows)) throw new Error("OKX instruments response shape was not recognized");
  const candidate = rows.filter(x =>
    x.state === "live" &&
    String(x.settleCcy).toUpperCase() === "USDT"
  );
  const spotPayload = await getJson("https://www.okx.com/api/v5/public/instruments?instType=SPOT");
  const spotRows = Array.isArray(spotPayload?.data) ? spotPayload.data : [];
  const spotBases = new Set(spotRows.filter(x => x.state === "live").map(x => String(x.baseCcy ?? "").toUpperCase()));
  const spotBacked = candidate.filter(x => spotBases.has(String(x.instId).split("-")[0].toUpperCase()));
  report.venues.OKX = {
    all: summarize(rows, ["instId", "state", "settleCcy", "ctType"]),
    activeUsdtSwapCandidate: {
      ...summarize(candidate, ["instId", "state", "settleCcy", "ctType"]),
      symbols: candidate.map(x => x.instId),
      bases: candidate.map(x => String(x.instId).split("-")[0].toUpperCase())
    },
    spotSymbolCount: spotRows.length,
    activeUsdtSwapsBackedBySpotBase: {
      ...summarize(spotBacked, ["instId", "settleCcy"]),
      symbols: spotBacked.map(x => x.instId)
    }
  };
}

// BingX official perpetual contract metadata.
{
  const payload = await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/contracts");
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data?.contracts;
  if (Number(payload?.code) !== 0 || !Array.isArray(rows)) throw new Error("BingX contract metadata response shape was not recognized");
  const activeUsdt = rows.filter(x => Number(x.status) === 1 && String(x.currency).toUpperCase() === "USDT");
  const spotPayload = await getJson("https://open-api.bingx.com/openApi/spot/v1/common/symbols");
  const spotSymbols = Array.isArray(spotPayload?.data?.symbols) ? spotPayload.data.symbols : [];
  const spotBases = new Set(spotSymbols.filter(x => Number(x.status) === 1).map(x => String(x.symbol).split("-")[0].toUpperCase()));
  const spotBacked = activeUsdt.filter(x => spotBases.has(String(x.asset).toUpperCase()));
  const cryptoPrefixCandidate = activeUsdt.filter(x =>
    !["NCCO", "NCFX", "NCS"].some(prefix => String(x.asset).toUpperCase().startsWith(prefix))
  );
  const knownNonCrypto = activeUsdt.filter(x =>
    ["NCCO", "NCFX", "NCS"].some(prefix => String(x.asset).toUpperCase().startsWith(prefix))
  );
  report.venues.BingX = {
    all: summarize(rows, ["symbol", "status", "currency", "asset", "contractId"]),
    activeUsdtCandidate: {
      ...summarize(activeUsdt, ["symbol", "status", "currency", "asset"]),
      symbols: activeUsdt.map(x => x.symbol),
      assets: activeUsdt.map(x => x.asset)
    },
    activeSpotSymbolCount: spotSymbols.length,
    activeUsdtContractsBackedBySpotBase: {
      ...summarize(spotBacked, ["symbol", "status", "currency", "asset"]),
      symbols: spotBacked.map(x => x.symbol)
    },
    knownNonCryptoByOfficialAssetPrefix: {
      ...summarize(knownNonCrypto, ["symbol", "asset"]),
      symbols: knownNonCrypto.map(x => x.symbol),
      assets: knownNonCrypto.map(x => x.asset)
    },
    nonCryptoAssetPrefixFilteredCandidate: {
      ...summarize(cryptoPrefixCandidate, ["symbol", "asset"]),
      symbols: cryptoPrefixCandidate.map(x => x.symbol),
      assets: cryptoPrefixCandidate.map(x => x.asset)
    }
  };
}

// WEEX official exchange information, including crypto-vs-TradFi fields.
{
  const payload = await getJson("https://api-contract.weex.com/capi/v3/market/exchangeInfo");
  const rows = payload?.symbols;
  if (!Array.isArray(rows)) throw new Error("WEEX exchangeInfo did not return symbols[]");
  const candidate = rows.filter(x =>
    x.contractType === "PERPETUAL" &&
    x.underlyingType === "COIN" &&
    x.quoteAsset === "USDT" &&
    x.marginAsset === "USDT" &&
    x.forwardContractFlag === true
  );
  const apiSymbols = await getJson("https://api-contract.weex.com/capi/v3/market/apiTradingSymbols");
  if (!Array.isArray(apiSymbols)) throw new Error("WEEX apiTradingSymbols response was not an array");
  const apiEligible = candidate.filter(x => apiSymbols.includes(x.symbol));
  const notApiEligible = candidate.filter(x => !apiSymbols.includes(x.symbol));
  const suffixAliases = notApiEligible.filter(x => x.symbol.endsWith("S") && apiSymbols.includes(x.symbol.slice(0, -1)));
  const nonTradFi = candidate.filter(x => !(Array.isArray(x.underlyingSubType) && x.underlyingSubType.includes("TradFi")));
  const apiEligibleNonTradFi = apiEligible.filter(x => !(Array.isArray(x.underlyingSubType) && x.underlyingSubType.includes("TradFi")));
  const knownNonCrypto = rows.filter(x =>
    x.underlyingType !== "COIN" ||
    (Array.isArray(x.underlyingSubType) && x.underlyingSubType.includes("TradFi"))
  );
  report.venues.WEEX = {
    all: summarize(rows, ["symbol", "contractType", "underlyingType", "underlyingSubType", "quoteAsset", "marginAsset", "forwardContractFlag"]),
    usdtCryptoPerpetualCandidate: summarize(candidate, ["symbol", "contractType", "underlyingType", "underlyingSubType"]),
    apiTradingSymbolsCount: apiSymbols.length,
    apiEligibleUsdtCryptoPerpetual: {
      ...summarize(apiEligible, ["symbol", "contractType", "underlyingType", "underlyingSubType"]),
      symbols: apiEligible.map(x => x.symbol)
    },
    apiEligibleNonTradFi: {
      ...summarize(apiEligibleNonTradFi, ["symbol", "underlyingSubType"]),
      symbols: apiEligibleNonTradFi.map(x => x.symbol)
    },
    nonTradFiCandidate: {
      ...summarize(nonTradFi, ["symbol", "underlyingSubType"]),
      symbols: nonTradFi.map(x => x.symbol)
    },
    knownNonCryptoByOfficialMetadata: {
      ...summarize(knownNonCrypto, ["symbol", "underlyingType", "underlyingSubType"]),
      symbols: knownNonCrypto.map(x => x.symbol)
    },
    suffixAliasesNotInApiTradingSymbols: suffixAliases.map(x => ({ symbol: x.symbol, canonical: x.symbol.slice(0, -1) })),
    nonApiEligibleSymbols: notApiEligible.map(x => x.symbol),
    symbolsEndingInS: notApiEligible.filter(x => x.symbol.endsWith("S")).map(x => x.symbol)
  };
}

// HTX official linear-swap contract metadata.
{
  const payload = await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?business_type=swap");
  const rows = payload?.data;
  if (payload?.status !== "ok" || !Array.isArray(rows)) throw new Error("HTX swap_contract_info response shape was not recognized");
  const candidate = rows.filter(x =>
    Number(x.contract_status) === 1 &&
    x.business_type === "swap" &&
    x.contract_type === "swap" &&
    String(x.trade_partition).toUpperCase() === "USDT"
  );
  const spotPayload = await getJson("https://api.huobi.pro/v1/common/symbols");
  const spotRows = Array.isArray(spotPayload?.data) ? spotPayload.data : [];
  const allSpotBases = new Set(spotRows.map(x => String(x["base-currency"] ?? "").toUpperCase()));
  const onlineSpotBases = new Set(spotRows.filter(x => x.state === "online").map(x => String(x["base-currency"] ?? "").toUpperCase()));
  const currencyPayload = await getJson("https://api.huobi.pro/v1/common/currencys");
  const currencyRows = Array.isArray(currencyPayload?.data) ? currencyPayload.data : [];
  const currencySet = new Set(currencyRows.map(x => String(typeof x === "string" ? x : x.currency ?? x.coin ?? "").toUpperCase()));
  const contractBase = x => String(x.contract_code ?? "").split("-")[0].toUpperCase();
  const spotBacked = candidate.filter(x => allSpotBases.has(contractBase(x)));
  const currencyBacked = candidate.filter(x => currencySet.has(contractBase(x)));
  report.venues.HTX = {
    all: summarize(rows, ["contract_code", "symbol", "contract_status", "business_type", "contract_type", "trade_partition"]),
    activeUsdtSwapCandidate: {
      ...summarize(candidate, ["contract_code", "symbol", "contract_status", "business_type", "contract_type", "trade_partition"]),
      contractCodes: candidate.map(x => x.contract_code),
      symbols: candidate.map(x => x.symbol)
    },
    spotSymbolCount: spotRows.length,
    allSpotBaseCount: allSpotBases.size,
    onlineSpotBaseCount: onlineSpotBases.size,
    activeUsdtSwapsBackedBySpotBase: {
      ...summarize(spotBacked, ["contract_code", "symbol"]),
      contractCodes: spotBacked.map(x => x.contract_code)
    },
    currencyListCount: currencyRows.length,
    currencyRowKeys: [...new Set(currencyRows.flatMap(x => Object.keys(typeof x === "object" ? x : {})))].sort(),
    currencyRowsSample: currencyRows.slice(0, 12),
    spotRowsSample: spotRows.slice(0, 8),
    activeUsdtSwapsBackedByCurrencyList: {
      ...summarize(currencyBacked, ["contract_code", "symbol"]),
      contractCodes: currencyBacked.map(x => x.contract_code)
    }
  };
}

// KuCoin official active futures contracts with explicit CRYPTO classification.
{
  const payload = await getJson("https://api-futures.kucoin.com/api/v1/contracts/active");
  const rows = payload?.data;
  if (payload?.code !== "200000" || !Array.isArray(rows)) throw new Error("KuCoin active contracts response shape was not recognized");
  const candidate = rows.filter(x =>
    x.status === "Open" &&
    x.quoteCurrency === "USDT" &&
    x.settleCurrency === "USDT" &&
    x.marketType === "CRYPTO" &&
    x.assetClass === "CRYPTO"
  );
  const knownNonCrypto = rows.filter(x => x.marketType !== "CRYPTO" || x.assetClass !== "CRYPTO");
  report.venues.KuCoin = {
    all: summarize(rows, ["symbol", "status", "quoteCurrency", "settleCurrency", "marketType", "assetClass"]),
    activeUsdtCryptoCandidate: {
      ...summarize(candidate, ["symbol", "status", "quoteCurrency", "settleCurrency", "marketType", "assetClass"]),
      symbols: candidate.map(x => x.symbol),
      bases: candidate.map(x => String(x.baseCurrency ?? x.base ?? "").toUpperCase())
    },
    knownNonCryptoByOfficialMetadata: {
      ...summarize(knownNonCrypto, ["symbol", "marketType", "assetClass"]),
      symbols: knownNonCrypto.map(x => x.symbol),
      bases: knownNonCrypto.map(x => String(x.baseCurrency ?? x.base ?? "").toUpperCase())
    }
  };
}

// XT official listed/tradeable USDT-M symbols. Preserve category metadata for a
// grounded follow-up filter; do not infer crypto status from symbol spelling.
{
  const payload = await getJson("https://fapi.xt.com/future/market/v3/public/symbol/list");
  const rows = Array.isArray(payload?.result?.symbols) ? payload.result.symbols
    : Array.isArray(payload?.result) ? payload.result
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.result?.list) ? payload.result.list
    : null;
  if (!rows) {
    report.venues.XT = {
      error: "XT symbol list response shape was not recognized",
      responseKeys: Object.keys(payload ?? {}),
      responsePreview: JSON.stringify(payload).slice(0, 5000)
    };
  } else {
    const usdtPerpetual = rows.filter(x =>
      x.contractType === "PERPETUAL" &&
      x.productType === "perpetual" &&
      String(x.quoteCoin).toUpperCase() === "USDT"
    );
    const platesPayload = await getJson("https://fapi.xt.com/future/market/v1/public/plate/list");
    const plates = Array.isArray(platesPayload?.result) ? platesPayload.result : platesPayload?.result?.items ?? [];
    const nonCryptoPlateNames = new Set(["TradFi", "FOREX", "Tokenized Stocks", "Commodities", "Metals", "Indices", "Pre-IPO"]);
    const nonCryptoPlateIds = new Set(plates.filter(x => nonCryptoPlateNames.has(x.plate)).map(x => Number(x.id)));
    const cryptoOnly = usdtPerpetual.filter(x =>
      x.tradeSwitch === true && x.openSwitch === true && x.isOpenApi === true &&
      !(Array.isArray(x.plates) && x.plates.some(id => nonCryptoPlateIds.has(Number(id))))
    );
    const nonCryptoUsdtPerpetual = usdtPerpetual.filter(x =>
      Array.isArray(x.plates) && x.plates.some(id => nonCryptoPlateIds.has(Number(id)))
    );
    report.venues.XT = {
      all: summarize(rows, ["symbol", "baseCoin", "quoteCoin", "contractType", "productType", "underlyingType", "state", "tradeSwitch", "openSwitch", "isOpenApi", "isDisplay", "displaySwitch", "symbolGroupId", "labels", "plates"]),
      usdtPerpetualCandidate: summarize(usdtPerpetual, ["symbol", "baseCoin", "quoteCoin", "contractType", "productType", "underlyingType", "state", "tradeSwitch", "openSwitch", "isOpenApi", "isDisplay", "displaySwitch", "symbolGroupId", "labels", "plates"]),
      platesMetadata: { ...summarize(plates, ["id", "plate", "symbolSortRule"]), all: plates },
      nonCryptoPlateIds: [...nonCryptoPlateIds],
      nonCryptoUsdtPerpetual: {
        ...summarize(nonCryptoUsdtPerpetual, ["symbol", "baseCoin", "plates"]),
        symbols: nonCryptoUsdtPerpetual.map(x => x.symbol),
        bases: nonCryptoUsdtPerpetual.map(x => String(x.baseCoin ?? "").toUpperCase())
      },
      cryptoOnlyCandidate: {
        ...summarize(cryptoOnly, ["symbol", "baseCoin", "symbolGroupId", "plates", "labels"]),
        symbols: cryptoOnly.map(x => x.symbol),
        bases: cryptoOnly.map(x => String(x.baseCoin ?? "").toUpperCase())
      }
    };
  }
}

const baseFromPair = value => String(value ?? "").toUpperCase()
  .replace(/[_-]USDTM?$/, "")
  .replace(/[_-]USDT$/, "")
  .replace(/USDTM?$/, "")
  .replace(/[_-]/g, "");
const referenceBases = new Set([
  ...(report.venues.MEXC?.activeUsdtPerpetualCandidate?.bases ?? []),
  ...(report.venues.OKX?.activeUsdtSwapCandidate?.bases ?? []),
  ...(report.venues.KuCoin?.activeUsdtCryptoCandidate?.bases ?? []),
  ...(report.venues.XT?.cryptoOnlyCandidate?.bases ?? [])
].map(baseFromPair).filter(Boolean));
const geckoRows = await getJson("https://api.coingecko.com/api/v3/coins/list?include_platform=false");
if (!Array.isArray(geckoRows)) throw new Error("CoinGecko coin list response was not an array");
const geckoSymbols = new Set(geckoRows.map(x => String(x.symbol ?? "").toUpperCase()).filter(Boolean));
const htxCandidateCodes = report.venues.HTX?.activeUsdtSwapCandidate?.contractCodes ?? [];
const htxGeckoMatched = htxCandidateCodes.filter(code => geckoSymbols.has(baseFromPair(code)));
const htxGeckoMatchedNonTradFi = htxGeckoMatched.filter(code => !knownNonCryptoBases.has(baseFromPair(code)));
report.coingeckoReference = {
  coinListCount: geckoRows.length,
  uniqueSymbols: geckoSymbols.size,
  HTX: {
    geckoSymbolMatches: htxGeckoMatched.length,
    geckoMatchesAfterOfficialTradFiExclusions: htxGeckoMatchedNonTradFi.length,
    geckoMatchedContractCodes: htxGeckoMatched,
    geckoMatchedNonTradFiContractCodes: htxGeckoMatchedNonTradFi
  },
  MEXC: {
    geckoSymbolMatches: (report.venues.MEXC?.activeUsdtPerpetualCandidate?.bases ?? []).filter(base => geckoSymbols.has(baseFromPair(base))).length
  },
  OKX: {
    geckoSymbolMatches: (report.venues.OKX?.activeUsdtSwapCandidate?.bases ?? []).filter(base => geckoSymbols.has(baseFromPair(base))).length
  }
};
const knownNonCryptoBases = new Set([
  ...(report.venues.BingX?.knownNonCryptoByOfficialAssetPrefix?.assets ?? []),
  ...(report.venues.WEEX?.knownNonCryptoByOfficialMetadata?.symbols ?? []),
  ...(report.venues.KuCoin?.knownNonCryptoByOfficialMetadata?.bases ?? []),
  ...(report.venues.XT?.nonCryptoUsdtPerpetual?.bases ?? [])
].map(baseFromPair).filter(Boolean));
const htxCodes = report.venues.HTX?.activeUsdtSwapCandidate?.contractCodes ?? [];
const htxNonCrypto = htxCodes.filter(code => knownNonCryptoBases.has(baseFromPair(code)));
const htxCryptoCandidate = htxCodes.filter(code => !knownNonCryptoBases.has(baseFromPair(code)));
const bingxRows = report.venues.BingX?.activeUsdtCandidate?.assets ?? [];
const bingxCrossExchange = bingxRows.filter(asset =>
  referenceBases.has(baseFromPair(asset)) &&
  !knownNonCryptoBases.has(baseFromPair(asset))
);
const weexRows = report.venues.WEEX?.nonTradFiCandidate?.symbols ?? [];
const weexCrossExchange = weexRows.filter(symbol =>
  referenceBases.has(baseFromPair(symbol)) &&
  !knownNonCryptoBases.has(baseFromPair(symbol))
);
report.crossExchangeCryptoReference = {
  referenceBaseCount: referenceBases.size,
  knownNonCryptoBaseCount: knownNonCryptoBases.size,
  referenceBases: [...referenceBases].sort(),
  knownNonCryptoBases: [...knownNonCryptoBases].sort(),
  BingX: { count: bingxCrossExchange.length, assets: bingxCrossExchange },
  WEEX: { count: weexCrossExchange.length, symbols: weexCrossExchange },
  HTX: {
    nonCryptoCount: htxNonCrypto.length,
    nonCryptoContractCodes: htxNonCrypto,
    cryptoCandidateCount: htxCryptoCandidate.length,
    cryptoCandidateContractCodes: htxCryptoCandidate
  },
  MEXC: {
    nonCryptoCount: (report.venues.MEXC?.activeUsdtPerpetualCandidate?.bases ?? []).filter(base => knownNonCryptoBases.has(baseFromPair(base))).length
  },
  OKX: {
    nonCryptoCount: (report.venues.OKX?.activeUsdtSwapCandidate?.bases ?? []).filter(base => knownNonCryptoBases.has(baseFromPair(base))).length
  }
};

await writeFile("seven-exchange-universe-audit.json", JSON.stringify(report, null, 2));
for (const [name, venue] of Object.entries(report.venues)) {
  const countSummary = Object.entries(venue)
    .filter(([key, value]) => key !== "all" && value && typeof value === "object" && Number.isFinite(value.count))
    .map(([key, value]) => `${key}=${value.count}`).join(" ");
  console.log(`UNIVERSE_AUDIT | ${name} | all=${venue.all?.count ?? "unknown"} | ${countSummary}`);
}
console.log(`CROSS_EXCHANGE_CRYPTO | refs=${referenceBases.size} | BingX=${bingxCrossExchange.length} | WEEX=${weexCrossExchange.length} | HTX_crypto_candidate=${htxCryptoCandidate.length} | HTX_known_noncrypto=${htxNonCrypto.length} | HTX_CoinGecko=${htxGeckoMatched.length}`);
console.log("UNIVERSE_AUDIT_FILE | seven-exchange-universe-audit.json");

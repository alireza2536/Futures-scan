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

// BingX official perpetual contract metadata.
{
  const payload = await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/contracts");
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.data?.contracts;
  if (Number(payload?.code) !== 0 || !Array.isArray(rows)) throw new Error("BingX contract metadata response shape was not recognized");
  const activeUsdt = rows.filter(x => Number(x.status) === 1 && String(x.currency).toUpperCase() === "USDT");
  report.venues.BingX = {
    all: summarize(rows, ["symbol", "status", "currency", "asset", "contractId"]),
    activeUsdtCandidate: summarize(activeUsdt, ["symbol", "status", "currency", "asset"])
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
  report.venues.WEEX = {
    all: summarize(rows, ["symbol", "contractType", "underlyingType", "underlyingSubType", "quoteAsset", "marginAsset", "forwardContractFlag"]),
    usdtCryptoPerpetualCandidate: summarize(candidate, ["symbol", "contractType", "underlyingType", "underlyingSubType"])
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
  report.venues.HTX = {
    all: summarize(rows, ["contract_code", "symbol", "contract_status", "business_type", "contract_type", "trade_partition"]),
    activeUsdtSwapCandidate: summarize(candidate, ["contract_code", "symbol", "contract_status", "business_type", "contract_type", "trade_partition"])
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
  report.venues.KuCoin = {
    all: summarize(rows, ["symbol", "status", "quoteCurrency", "settleCurrency", "marketType", "assetClass"]),
    activeUsdtCryptoCandidate: summarize(candidate, ["symbol", "status", "quoteCurrency", "settleCurrency", "marketType", "assetClass"])
  };
}

// XT official listed/tradeable USDT-M symbols. Preserve category metadata for a
// grounded follow-up filter; do not infer crypto status from symbol spelling.
{
  const payload = await getJson("https://fapi.xt.com/future/market/v3/public/symbol/list");
  const rows = payload?.result;
  if (Number(payload?.returnCode) !== 0 || !Array.isArray(rows)) throw new Error("XT symbol list response shape was not recognized");
  const usdtPerpetual = rows.filter(x =>
    x.contractType === "PERPETUAL" &&
    x.productType === "perpetual" &&
    x.quoteCoin === "USDT" &&
    String(x.underlyingType).toUpperCase().includes("USDT")
  );
  report.venues.XT = {
    all: summarize(rows, ["symbol", "baseCoin", "quoteCoin", "contractType", "productType", "underlyingType", "state", "tradeSwitch", "isOpenApi", "isDisplay", "labels", "plates"]),
    usdtPerpetualCandidate: summarize(usdtPerpetual, ["symbol", "baseCoin", "quoteCoin", "contractType", "productType", "underlyingType", "state", "tradeSwitch", "isOpenApi", "isDisplay", "labels", "plates"])
  };
}

await writeFile("seven-exchange-universe-audit.json", JSON.stringify(report, null, 2));
for (const [name, venue] of Object.entries(report.venues)) {
  const candidateKey = Object.keys(venue).find(key => key !== "all");
  console.log(`UNIVERSE_AUDIT | ${name} | all=${venue.all.count} | ${candidateKey}=${venue[candidateKey].count}`);
  console.log(`UNIVERSE_FIELDS | ${name} | ${JSON.stringify(venue.all.fields)}`);
}
console.log("UNIVERSE_AUDIT_FILE | seven-exchange-universe-audit.json");

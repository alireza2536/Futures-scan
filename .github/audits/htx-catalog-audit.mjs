const headers = { accept: "application/json", "user-agent": "Futures-scan-HTX-catalog-audit/1.0" };

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error(`Non-JSON HTTP ${response.status}: ${raw.slice(0, 180)}`); }
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 180)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("HTX request failed");
}

const [contractsPayload, spotPayload] = await Promise.all([
  getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info"),
  getJson("https://api.huobi.pro/v1/common/symbols")
]);
if (contractsPayload.status !== "ok" || !Array.isArray(contractsPayload.data)) throw new Error("HTX futures catalog schema invalid");
if (spotPayload.status !== "ok" || !Array.isArray(spotPayload.data)) throw new Error("HTX spot catalog schema invalid");

const contracts = contractsPayload.data.filter(row =>
  Number(row?.contract_status) === 1 &&
  String(row?.business_type).toLowerCase() === "swap" &&
  String(row?.contract_type).toLowerCase() === "swap" &&
  String(row?.trade_partition).toUpperCase() === "USDT" &&
  String(row?.contract_code ?? "").toUpperCase().endsWith("-USDT")
);
const activeSpot = spotPayload.data.filter(row => String(row?.state).toLowerCase() === "online");
const spotBases = new Set(activeSpot.map(row => String(row?.["base-currency"] ?? "").toUpperCase()).filter(Boolean));
const intersection = contracts.filter(row => spotBases.has(String(row?.symbol ?? "").toUpperCase()));
const noSpotMatch = contracts.filter(row => !spotBases.has(String(row?.symbol ?? "").toUpperCase()));
const knownNonCrypto = new Set(["XAU","XAG","XPT","XPD","JP225","JP225USD","SPX","SPX500","US30","USOIL","META","NVDL","NVDAX","AAPL","NVDA","MSFT","TSLA","SILVER","GOLD"]);
const knownNonCryptoRows = contracts.filter(row => knownNonCrypto.has(String(row?.symbol ?? "").toUpperCase()));
const report = {
  generatedAt: new Date().toISOString(),
  endpoints: {
    futures: "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info",
    spot: "https://api.huobi.pro/v1/common/symbols"
  },
  totals: {
    futuresRows: contractsPayload.data.length,
    activeUsdtCryptoTypePerpetualCandidates: contracts.length,
    spotRows: spotPayload.data.length,
    activeSpotRows: activeSpot.length,
    uniqueActiveSpotBases: spotBases.size,
    futuresWithActiveSpotBase: intersection.length,
    futuresWithoutActiveSpotBase: noSpotMatch.length
  },
  knownNonCryptoCandidates: knownNonCryptoRows.map(row => ({
    symbol: row.symbol, contract_code: row.contract_code,
    contract_status: row.contract_status, trade_partition: row.trade_partition,
    hasActiveSpotBase: spotBases.has(String(row.symbol ?? "").toUpperCase())
  })),
  noSpotMatch: noSpotMatch.map(row => ({
    symbol: row.symbol, contract_code: row.contract_code,
    contract_status: row.contract_status, trade_partition: row.trade_partition
  })),
  spotBaseExamples: [...spotBases].slice(0, 30)
};
await (await import("node:fs/promises")).writeFile("htx-catalog-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (contracts.length === 0 || activeSpot.length === 0) process.exitCode = 1;

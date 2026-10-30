const TIMEOUT_MS = 15000;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": "Futures-scan-connectivity-check/1.0" },
      signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 250)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function report(exchange, item, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${exchange} | ${item} | ${detail}`);
  return ok;
}

async function checkOkx(base) {
  const exchange = `OKX (${base})`;
  try {
    const instruments = await getJson(`${base}/api/v5/public/instruments?instType=SWAP`);
    if (instruments.code !== "0" || !Array.isArray(instruments.data)) {
      throw new Error(`instrument response code=${instruments.code ?? "missing"} msg=${instruments.msg ?? ""}`);
    }
    const btc = instruments.data.find(x => x.instId === "BTC-USDT-SWAP" && x.state === "live");
    report(exchange, "SWAP instruments", true, `${instruments.data.length} instruments; BTC-USDT-SWAP ${btc ? "live" : "not listed/live"}`);
    if (!btc) return false;

    for (const [label, bar] of [["15m", "15m"], ["4h", "4H"], ["1d", "1D"]]) {
      const result = await getJson(`${base}/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${bar}&limit=100`);
      const rows = result.data;
      const ok = result.code === "0" && Array.isArray(rows) && rows.length >= 2 &&
        rows.every(row => Array.isArray(row) && row.length >= 6 && Number.isFinite(Number(row[4])));
      report(exchange, `${label} candles`, ok, ok ? `${rows.length} candles received` : `code=${result.code}; ${result.msg ?? "invalid candle payload"}`);
      if (!ok) return false;
    }
    return true;
  } catch (error) {
    report(exchange, "connection", false, error.message);
    return false;
  }
}

async function checkMexc() {
  const base = "https://api.mexc.com";
  const exchange = "MEXC Futures";
  try {
    const contracts = await getJson(`${base}/api/v1/contract/detail`);
    if (contracts.success !== true || !Array.isArray(contracts.data)) {
      throw new Error(`contract detail rejected: code=${contracts.code ?? "missing"} ${contracts.message ?? ""}`);
    }
    const btc = contracts.data.find(x => x.symbol === "BTC_USDT");
    report(exchange, "contract list", true, `${contracts.data.length} contracts; BTC_USDT ${btc ? "listed" : "not listed"}`);
    if (!btc) return false;

    for (const [label, interval] of [["15m", "Min15"], ["4h", "Hour4"], ["1d", "Day1"]]) {
      const result = await getJson(`${base}/api/v1/contract/kline/BTC_USDT?interval=${interval}`);
      const data = result.data;
      const count = Array.isArray(data?.time) ? data.time.length : 0;
      const ok = result.success === true && count >= 2 &&
        ["open", "high", "low", "close", "vol"].every(key => Array.isArray(data[key]) && data[key].length === count);
      report(exchange, `${label} candles`, ok, ok ? `${count} candles received` : `code=${result.code ?? "missing"}; invalid candle payload`);
      if (!ok) return false;
    }
    return true;
  } catch (error) {
    report(exchange, "connection", false, error.message);
    return false;
  }
}

const results = await Promise.all([
  checkOkx("https://eea.okx.com"),
  checkOkx("https://openapi.okx.com"),
  checkMexc()
]);
const okx = results[0] || results[1];
console.log("");
console.log(`SUMMARY | OKX=${okx ? "PASS" : "FAIL"} | MEXC=${results[2] ? "PASS" : "FAIL"}`);
if (!okx || !results[2]) process.exitCode = 1;

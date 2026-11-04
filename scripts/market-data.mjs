const DEFAULT_TIMEOUT_MS = 20000;

async function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS, extraHeaders = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.2", ...extraHeaders },
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429 || ["50011", "100410", "100429"].includes(String(body?.code))) {
        if (attempt === 4) throw new Error(`HTTP/API rate limit for ${url}: ${body?.code ?? response.status}`);
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Request retries exhausted for ${url}`);
}

function validBar(bar) {
  return Number.isFinite(bar.timestamp) &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.high >= bar.low && bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close);
}

function dedupeAndSort(bars) {
  const byTime = new Map();
  for (const bar of bars) {
    if (validBar(bar)) byTime.set(bar.timestamp, bar);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function okxRowToBar(row) {
  return {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    confirmed: row[8] === undefined ? null : row[8] === "1"
  };
}

export async function fetchOkxHistory({
  base = "https://openapi.okx.com",
  instId = "BTC-USDT-SWAP",
  bar = "4H",
  count = 1201
} = {}) {
  if (!Number.isInteger(count) || count < 2) throw new Error("count must be an integer >= 2");
  const collected = [];
  let cursor = null;
  let page = 0;
  while (collected.length < count && page < 20) {
    const params = new URLSearchParams({ instId, bar, limit: "100" });
    if (cursor !== null) params.set("after", String(cursor));
    const endpoint = page === 0
      ? "/api/v5/market/candles"
      : "/api/v5/market/history-candles";
    const payload = await requestJson(`${base}${endpoint}?${params}`);
    if (payload.code !== "0" || !Array.isArray(payload.data)) {
      throw new Error(`OKX ${endpoint} rejected: code=${payload.code ?? "missing"} ${payload.msg ?? ""}`);
    }
    if (payload.data.length === 0) break;
    const pageBars = payload.data.map(okxRowToBar);
    collected.push(...pageBars);
    const oldest = Math.min(...pageBars.map(x => x.timestamp));
    if (!Number.isFinite(oldest) || oldest === cursor) break;
    cursor = oldest;
    page += 1;
  }
  const bars = dedupeAndSort(collected);
  if (bars.length < count) {
    throw new Error(`OKX returned only ${bars.length}/${count} unique valid ${bar} bars for ${instId}`);
  }
  return bars.slice(-count);
}

function mexcRowsToBars(data) {
  if (!data || !Array.isArray(data.time)) return [];
  return data.time.map((time, index) => ({
    timestamp: Number(time) * 1000,
    open: Number(data.open?.[index]),
    high: Number(data.high?.[index]),
    low: Number(data.low?.[index]),
    close: Number(data.close?.[index]),
    volume: Number(data.vol?.[index]),
    confirmed: null
  }));
}

const MEXC_INTERVALS = {
  "15m": { api: "Min15", seconds: 15 * 60 },
  "1h": { api: "Hour1", seconds: 60 * 60 },
  "2h": { api: "Hour2", seconds: 2 * 60 * 60 },
  "4h": { api: "Hour4", seconds: 4 * 60 * 60 },
  "1d": { api: "Day1", seconds: 24 * 60 * 60 }
};

const BINGX_INTERVAL_MS = { "15m": 900000, "1h": 3600000, "2h": 7200000, "4h": 14400000, "1d": 86400000 };

export async function fetchBingXHistory({
  symbol = "BTC-USDT", marketId = null, interval = "4h", count = 1202,
  base = "https://open-api.bingx.com"
} = {}) {
  const duration = BINGX_INTERVAL_MS[interval];
  if (!duration) throw new Error(`Unsupported BingX interval: ${interval}`);
  if (!Number.isInteger(count) || count < 2) throw new Error("count must be an integer >= 2");
  const contractSymbol = marketId || symbol;
  const target = count + 8;
  const byTime = new Map();
  const now = Date.now();
  let endTime = now;
  let pages = 0;
  let lastPageInfo = null;
  const maxPages = Math.ceil(target / 1400) + 3;
  while (byTime.size < target && pages < maxPages) {
    const limit = Math.min(1000, Math.max(100, target - byTime.size + 8));
    const paramsObject = { symbol: contractSymbol, interval, limit: String(limit) };
    if (pages > 0) {
      const startTime = Math.max(0, endTime - (limit + 2) * duration);
      paramsObject.startTime = String(Math.trunc(startTime));
      paramsObject.endTime = String(Math.trunc(endTime));
    }
    const params = new URLSearchParams(paramsObject);
    const requestUrl = `${base}/openApi/swap/v3/quote/klines?${params}`;
    const payload = await requestJson(requestUrl, DEFAULT_TIMEOUT_MS, { "X-SOURCE-KEY": "BX-AI-SKILL" });
    lastPageInfo = { url: requestUrl, code: payload?.code, message: payload?.msg, dataLength: Array.isArray(payload?.data) ? payload.data.length : null, sample: Array.isArray(payload?.data) ? payload.data[0] ?? null : payload?.data };
    if (Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
      throw new Error(`BingX ${interval} kline rejected for ${contractSymbol}: ${payload?.msg ?? payload?.code ?? "invalid response"}`);
    }
    const before = byTime.size;
    for (const row of payload.data) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const bar = {
        timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), confirmed: null
      };
      const closeTime = Number(row[6] ?? (bar.timestamp + duration - 1));
      if (closeTime >= now || bar.timestamp + duration > now || !validBar(bar)) continue;
      byTime.set(bar.timestamp, bar);
    }
    pages += 1;
    if (byTime.size === before) break;
    const oldest = Math.min(...byTime.keys());
    if (!Number.isFinite(oldest) || oldest <= 0) break;
    endTime = oldest - 1;
    if (byTime.size < target) await new Promise(resolve => setTimeout(resolve, 150));
  }
  const bars = dedupeAndSort([...byTime.values()]);
  if (bars.length < count) {
    throw new Error(`BingX returned only ${bars.length}/${count} closed valid ${interval} candles for ${contractSymbol} after ${pages} pages; lastPage=${JSON.stringify(lastPageInfo).slice(0, 700)}`);
  }
  return bars.slice(-count);
}

export async function fetchMexcHistory({
  base = "https://api.mexc.com",
  symbol = "BTC_USDT",
  interval = "4h",
  count = 1201
} = {}) {
  const spec = MEXC_INTERVALS[interval];
  if (!spec) throw new Error(`Unsupported MEXC interval: ${interval}`);
  if (!Number.isInteger(count) || count < 2 || count > 2000) {
    throw new Error("MEXC count must be an integer from 2 to 2000");
  }
  const end = Math.floor(Date.now() / 1000);
  const start = end - spec.seconds * (count + 10);
  const params = new URLSearchParams({
    interval: spec.api,
    start: String(start),
    end: String(end)
  });
  const payload = await requestJson(`${base}/api/v1/contract/kline/${encodeURIComponent(symbol)}?${params}`);
  if (payload.success !== true) {
    throw new Error(`MEXC kline rejected: code=${payload.code ?? "missing"} ${payload.message ?? ""}`);
  }
  const bars = dedupeAndSort(mexcRowsToBars(payload.data));
  if (bars.length < count) {
    throw new Error(`MEXC returned only ${bars.length}/${count} unique valid ${interval} bars for ${symbol}`);
  }
  return bars.slice(-count);
}


const WEEX_INTERVALS = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const WEEX_MS = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };

async function weexJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.2" },
        signal: controller.signal
      });
      const bodyText = await response.text();
      let body;
      try { body = JSON.parse(bodyText); }
      catch { throw new Error(`WEEX returned non-JSON response: ${bodyText.slice(0, 160)}`); }
      if (response.status === 429) {
        if (attempt === 3) throw new Error("WEEX rate limit after retries");
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`WEEX HTTP ${response.status}: ${JSON.stringify(body).slice(0, 180)}`);
      if (!Array.isArray(body) && !["00000", "0"].includes(String(body?.code))) {
        throw new Error(`WEEX API ${body?.code ?? "unknown"}: ${body?.msg ?? "request rejected"}`);
      }
      return Array.isArray(body) ? body : body.data;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("WEEX request failed");
}

export async function fetchWeexHistory({
  symbol = "BTC/USDT:USDT", marketId = null, interval = "4h", count = 1202,
  base = "https://api-contract.weex.com"
} = {}) {
  const apiInterval = WEEX_INTERVALS[interval];
  const duration = WEEX_MS[interval];
  if (!apiInterval) throw new Error(`Unsupported WEEX interval: ${interval}`);
  if (!Number.isInteger(count) || count < 2) throw new Error("count must be an integer >= 2");
  const contractSymbol = marketId || symbol.replace("/", "").split(":")[0];
  const now = Date.now();
  const target = count + 8;
  const byTime = new Map();
  const addRows = rows => {
    for (const row of rows ?? []) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const bar = {
        timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), confirmed: null
      };
      if (bar.timestamp + duration > now || !validBar(bar)) continue;
      byTime.set(bar.timestamp, bar);
    }
  };
  const firstUrl = new URL(base + "/capi/v3/market/klines");
  firstUrl.search = new URLSearchParams({ symbol: contractSymbol, interval: apiInterval, limit: "1000" }).toString();
  addRows(await weexJson(firstUrl));
  let pages = 1;
  const maxPages = Math.ceil(target / 100) + 20;
  while (byTime.size < target && pages < maxPages) {
    const oldest = Math.min(...byTime.keys());
    if (!Number.isFinite(oldest) || oldest <= 0) break;
    const cursorEnd = oldest - duration;
    const pageStart = Math.max(0, cursorEnd - 99 * duration);
    const url = new URL(base + "/capi/v3/market/historyKlines");
    url.search = new URLSearchParams({
      symbol: contractSymbol, interval: apiInterval,
      startTime: String(Math.trunc(pageStart)), endTime: String(Math.trunc(cursorEnd)),
      limit: "100", priceType: "LAST"
    }).toString();
    const before = byTime.size;
    addRows(await weexJson(url));
    pages += 1;
    if (byTime.size === before) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const bars = dedupeAndSort([...byTime.values()]);
  if (bars.length < count) throw new Error(`WEEX returned only ${bars.length}/${count} closed valid ${interval} candles for ${contractSymbol} after ${pages} pages`);
  return bars.slice(-count);
}

const HTX_INTERVALS = { "15m": "15min", "1h": "60min", "2h": "2hour", "4h": "4hour", "1d": "1day" };
const HTX_SECONDS = { "15m": 900, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400 };

export async function fetchHtxHistory({
  symbol = "BTC/USDT:USDT", marketId = null, interval = "4h", count = 1202,
  base = "https://api.hbdm.com"
} = {}) {
  const period = HTX_INTERVALS[interval];
  const duration = HTX_SECONDS[interval] * 1000;
  if (!period) throw new Error(`Unsupported HTX interval: ${interval}`);
  if (!Number.isInteger(count) || count < 2 || count > 10000) throw new Error("HTX count must be an integer from 2 to 10000");
  const contractCode = marketId || symbol.replace("/", "-").replace(":USDT", "");
  const target = count + 8;
  const now = Math.floor(Date.now() / 1000);
  const durationSeconds = HTX_SECONDS[interval];
  const lastClosed = Math.floor(now / durationSeconds) * durationSeconds - durationSeconds;
  const firstNeeded = lastClosed - (target - 1) * durationSeconds;
  const byTime = new Map();
  const ranges = target <= 1900
    ? [{ size: target }]
    : Array.from({ length: Math.ceil(target / 1900) }, (_, index) => {
        const from = firstNeeded + index * 1900 * durationSeconds;
        return { from, to: Math.min(lastClosed, from + 1899 * durationSeconds) };
      });
  for (const range of ranges) {
    const url = new URL(base + "/linear-swap-ex/market/history/kline");
    const params = { contract_code: contractCode, period };
    if (range.size) params.size = String(Math.min(2000, range.size));
    else { params.from = String(range.from); params.to = String(range.to); }
    url.search = new URLSearchParams(params).toString();
    const payload = await requestJson(url);
    if (payload.status !== "ok" || !Array.isArray(payload.data)) {
      throw new Error(`HTX ${interval} history rejected: ${payload.err_msg ?? payload.status ?? "unknown response"}`);
    }
    for (const row of payload.data) {
      const bar = {
        timestamp: Number(row.id) * 1000, open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close), volume: Number(row.vol ?? row.amount), confirmed: null
      };
      if (bar.timestamp + duration > Date.now() || !validBar(bar)) continue;
      byTime.set(bar.timestamp, bar);
    }
    if (ranges.length > 1) await new Promise(resolve => setTimeout(resolve, 300));
  }
  const bars = dedupeAndSort([...byTime.values()]);
  if (bars.length < count) throw new Error(`HTX returned only ${bars.length}/${count} closed valid ${interval} candles for ${contractCode} across ${ranges.length} pages`);
  return bars.slice(-count);
}

const CCXT_INTERVALS = { '15m':'15m', '1h':'1h', '2h':'2h', '4h':'4h', '1d':'1d' };

export async function fetchCcxtHistory(exchange, { symbol, interval='4h', count=1201 } = {}) {
  const timeframe = CCXT_INTERVALS[interval];
  if (!timeframe || !exchange.timeframes?.[timeframe]) throw new Error(exchange.id + ' does not support ' + interval + ' OHLCV history');
  if (!Number.isInteger(count) || count < 2) throw new Error('count must be an integer >= 2');
  const duration = { '15m':900000, '1h':3600000, '2h':7200000, '4h':14400000, '1d':86400000 }[interval];
  const collected = new Map();
  const target = count + 2;
  let since = Date.now() - duration * (target + 4);
  let pages = 0;
  while (collected.size < target && pages < Math.ceil(target / 100) + 20) {
    const before = collected.size;
    const rows = await exchange.fetchOHLCV(symbol, timeframe, since, Math.min(1000, Math.max(100, target-collected.size+5)));
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const bar = { timestamp:Number(row[0]), open:Number(row[1]), high:Number(row[2]), low:Number(row[3]), close:Number(row[4]), volume:Number(row[5]), confirmed:null };
      if (validBar(bar) && bar.timestamp + duration <= Date.now()) collected.set(bar.timestamp, bar);
    }
    const times = rows.map(row => Number(row?.[0])).filter(Number.isFinite);
    const newest = times.length ? Math.max(...times) : NaN;
    if (!Number.isFinite(newest) || collected.size === before) break;
    since = newest + duration;
    pages += 1;
  }
  const bars = dedupeAndSort([...collected.values()]);
  if (bars.length < count) throw new Error(exchange.id + ' returned only ' + bars.length + '/' + count + ' closed valid ' + interval + ' candles for ' + symbol + ' after ' + pages + ' pages');
  return bars.slice(-count);
}

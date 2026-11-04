const DEFAULT_TIMEOUT_MS = 20000;

async function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.2" },
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429 || body?.code === "50011") {
        if (attempt === 4) throw new Error(`HTTP 429 rate limit for ${url}`);
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

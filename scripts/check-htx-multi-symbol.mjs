import { calculateLatestIndicators, calculateEMA } from "./indicators.mjs";
import { keepClosedFourHourCandles } from "./strategy.mjs";

const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"];
const TIMEFRAMES = [
  { label: "15m", period: "15min", ms: 900000, count: 2000 },
  { label: "4h", period: "4hour", ms: 14400000, count: 2000 },
  { label: "1d", period: "1day", ms: 86400000, count: 60 }
];

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Futures-scan/0.3" }, signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 180)}`);
    return body;
  } finally { clearTimeout(timer); }
}
function normalize(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    const b = { timestamp: Number(r.id) * 1000, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.vol ?? r.amount) };
    if ([b.timestamp,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) &&
      b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close)) map.set(b.timestamp,b);
  }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
async function run() {
  const contractPayload = await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info");
  if (contractPayload.status !== "ok" || !Array.isArray(contractPayload.data)) throw new Error("HTX contract list invalid");
  const available = new Set(contractPayload.data.filter(x => x.contract_status === 1 || x.contract_status === undefined).map(x=>x.contract_code));
  const outcomes = [];
  for (const symbol of SYMBOLS) {
    if (!available.has(symbol)) {
      outcomes.push({symbol,status:"BLOCKED",reason:"No active linear USDT contract found"});
      console.log(JSON.stringify(outcomes.at(-1)));
      continue;
    }
    const result = {symbol,status:"PASS",checks:[]};
    for (const tf of TIMEFRAMES) {
      try {
        const url = new URL("https://api.hbdm.com/linear-swap-ex/market/history/kline");
        url.search = new URLSearchParams({contract_code:symbol,period:tf.period,size:String(tf.count)}).toString();
        const payload = await getJson(url);
        if (payload.status !== "ok" || !Array.isArray(payload.data)) throw new Error(`Bad API payload: ${payload.status ?? "missing status"}`);
        const bars = normalize(payload.data);
        const min = tf.label === "1d" ? 50 : 1201;
        if (bars.length < min) throw new Error(`Only ${bars.length} valid candles; need ${min}`);
        const durationNow = Math.floor(Date.now()/tf.ms)*tf.ms;
        if (bars.at(-1).timestamp < durationNow - 2*tf.ms) throw new Error(`Stale latest candle ${new Date(bars.at(-1).timestamp).toISOString()}`);
        const item = {timeframe:tf.label,status:"PASS",candles:bars.length,latest:new Date(bars.at(-1).timestamp).toISOString()};
        if (tf.label === "4h") {
          const closed = keepClosedFourHourCandles(bars);
          if (closed.length < 1201) throw new Error(`Only ${closed.length} closed candles; need 1201`);
          const v = calculateLatestIndicators(closed,{emaLength:500,cciLength:1200});
          item.closedCandles = closed.length;
          item.close = v.close;
          item.ema500 = v.ema;
          item.cci1200 = v.cci;
          item.longConditionMet = v.close > v.ema && v.cci > 100;
        }
        if (tf.label === "1d") {
          const closes = bars.map(x=>x.close);
          item.ema20 = calculateEMA(closes,20).at(-1);
          item.ema50 = calculateEMA(closes,50).at(-1);
        }
        result.checks.push(item);
      } catch(e) {
        result.status = "BLOCKED";
        result.checks.push({timeframe:tf.label,status:"FAIL",reason:e.message});
      }
    }
    console.log(JSON.stringify(result));
    outcomes.push(result);
  }
  const pass = outcomes.filter(x=>x.status==="PASS").length;
  console.log("HTX_MULTI_SYMBOL_FINAL "+JSON.stringify({passed:pass,total:outcomes.length,outcomes}));
  if (pass !== outcomes.length) process.exitCode = 1;
}
await run();

const TIMEFRAMES = [
  { label: "1h", period: "60min", ms: 3600000 },
  { label: "2h", period: "2hour", ms: 7200000 }
];
const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"];

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Futures-scan/0.3" }, signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0,180)}`);
    return body;
  } finally { clearTimeout(timer); }
}
function normalize(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    const b = { timestamp:Number(r.id)*1000, open:Number(r.open), high:Number(r.high), low:Number(r.low), close:Number(r.close), volume:Number(r.vol ?? r.amount) };
    if ([b.timestamp,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) && b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close)) map.set(b.timestamp,b);
  }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
const contractPayload = await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info");
if (contractPayload.status !== "ok" || !Array.isArray(contractPayload.data)) throw new Error("HTX contract list invalid");
const active = new Set(contractPayload.data.filter(x=>x.contract_status===1 || x.contract_status===undefined).map(x=>x.contract_code));
const report = [];
for (const symbol of SYMBOLS) {
  const row = { exchange:"HTX", symbol, timeframes:[] };
  if (!active.has(symbol)) {
    row.status = "BLOCKED"; row.error = "No active USDT perpetual contract"; report.push(row); console.log(JSON.stringify(row)); continue;
  }
  row.status = "PASS";
  for (const tf of TIMEFRAMES) {
    try {
      const url = new URL("https://api.hbdm.com/linear-swap-ex/market/history/kline");
      url.search = new URLSearchParams({contract_code:symbol,period:tf.period,size:"2000"}).toString();
      const payload = await getJson(url);
      if (payload.status!=="ok" || !Array.isArray(payload.data)) throw new Error(`Invalid kline API response: ${payload.status ?? "missing status"}`);
      const bars = normalize(payload.data);
      const now = Date.now();
      const closed = bars.filter(b=>b.timestamp+tf.ms<=now);
      const latest = closed.at(-1);
      const staleLimit = Math.floor(now/tf.ms)*tf.ms-tf.ms;
      const item = {timeframe:tf.label,status:"PASS",received:bars.length,closedCandles:closed.length,latestClosed:latest?new Date(latest.timestamp).toISOString():null,meets1201:closed.length>=1201,latestFresh:Boolean(latest && latest.timestamp>=staleLimit)};
      if (closed.length<1201) { item.status="FAIL"; item.reason="Fewer than 1201 closed candles"; row.status="BLOCKED"; }
      if (!item.latestFresh) { item.status="FAIL"; item.reason=(item.reason?item.reason+"; ":"")+"Latest closed candle is stale"; row.status="BLOCKED"; }
      row.timeframes.push(item);
    } catch(e) { row.status="BLOCKED"; row.timeframes.push({timeframe:tf.label,status:"FAIL",error:e.message}); }
  }
  console.log(JSON.stringify(row)); report.push(row);
}
console.log("HTX_1H_2H_FINAL "+JSON.stringify({passed:report.filter(x=>x.status==="PASS").length,total:report.length,report}));
if (report.some(x=>x.status!=="PASS")) process.exitCode=1;

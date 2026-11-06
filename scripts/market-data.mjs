const DEFAULT_TIMEOUT_MS = 20000;

async function requestJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Futures-scan/0.6" },
        signal: controller.signal
      });
      const body = await response.json();
      if (response.status === 429 || body?.code === "50011") {
        if (attempt === 4) throw new Error(`HTTP 429 rate limit for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1) ** 2));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1) ** 2));
    } finally { clearTimeout(timer); }
  }
  throw lastError ?? new Error(`Request retries exhausted for ${url}`);
}

function validBar(bar) {
  return Number.isFinite(bar.timestamp) &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.volume >= 0 && bar.high >= bar.low &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close);
}
function dedupeAndSort(bars) {
  const byTime = new Map();
  for (const bar of bars) if (validBar(bar)) byTime.set(bar.timestamp, bar);
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
function okxRowToBar(row) {
  return { timestamp:Number(row[0]), open:Number(row[1]), high:Number(row[2]), low:Number(row[3]),
    close:Number(row[4]), volume:Number(row[5]), confirmed:row[8] === undefined ? null : row[8] === "1" };
}
export async function fetchOkxHistory({ base="https://openapi.okx.com", instId="BTC-USDT-SWAP", bar="4H", count=1201 }={}) {
  if (!Number.isInteger(count) || count < 2 || count > 2000) throw new Error("count must be an integer from 2 to 2000");
  const collected=[]; let cursor=null; let page=0;
  while (collected.length < count && page < 22) {
    const params=new URLSearchParams({instId,bar,limit:"100"});
    if (cursor !== null) params.set("after",String(cursor));
    const endpoint=page===0?"/api/v5/market/candles":"/api/v5/market/history-candles";
    const payload=await requestJson(`${base}${endpoint}?${params}`);
    if (payload.code!=="0" || !Array.isArray(payload.data)) throw new Error(`OKX ${endpoint} rejected: ${payload.msg ?? payload.code}`);
    if (!payload.data.length) break;
    const pageBars=payload.data.map(okxRowToBar); collected.push(...pageBars);
    const oldest=Math.min(...pageBars.map(x=>x.timestamp));
    if (!Number.isFinite(oldest) || oldest===cursor) break;
    cursor=oldest; page+=1;
  }
  const bars=dedupeAndSort(collected);
  if (bars.length<count) throw new Error(`OKX returned only ${bars.length}/${count} unique valid ${bar} bars for ${instId}`);
  return bars.slice(-count);
}
function mexcRowsToBars(data) {
  if (!data || !Array.isArray(data.time)) return [];
  return data.time.map((time,index)=>({timestamp:Number(time)*1000,open:Number(data.open?.[index]),
    high:Number(data.high?.[index]),low:Number(data.low?.[index]),close:Number(data.close?.[index]),
    volume:Number(data.vol?.[index]),confirmed:null}));
}
export const TIMEFRAMES = Object.freeze({
  "5m": { okx:"5m", mexc:"Min5", seconds:300 },
  "15m": { okx:"15m", mexc:"Min15", seconds:900 },
  "1h": { okx:"1H", mexc:"Min60", seconds:3600 },
  "2h": { okx:"2H", mexc:"Hour2", seconds:7200 },
  "4h": { okx:"4H", mexc:"Hour4", seconds:14400 },
  "1d": { okx:"1Dutc", mexc:"Day1", seconds:86400 }
});
export async function fetchMexcHistory({base="https://api.mexc.com",symbol="BTC_USDT",interval="4h",count=1201}={}) {
  if (!TIMEFRAMES[interval]) throw new Error(`Unsupported MEXC interval: ${interval}`);
  if (!Number.isInteger(count)||count<2||count>5000) throw new Error("MEXC count must be an integer from 2 to 5000");
  if(interval==="2h"){
    const hourly=await fetchMexcHistory({base,symbol,interval:"1h",count:count*2+4});
    const aggregated=aggregateHourlyTo2h(hourly);
    if(aggregated.length<count) throw new Error(`MEXC 2h aggregation returned only ${aggregated.length}/${count} candles`);
    return aggregated.slice(-count);
  }
  const spec=TIMEFRAMES[interval], intervalSeconds=spec.seconds;
  const collected=new Map();
  let cursor=Math.floor((Date.now()/1000-intervalSeconds*(count+5))/intervalSeconds)*intervalSeconds;
  for(let page=0;page<12&&collected.size<count;page+=1){
    const nowSeconds=Math.floor(Date.now()/1000);
    // Avoid sending an invalid range when the previous page reached the current candle.
    if(cursor>nowSeconds) break;
    const pageEnd=Math.min(nowSeconds,cursor+intervalSeconds*999);
    const params=new URLSearchParams({interval:spec.mexc,start:String(cursor),end:String(pageEnd)});
    const payload=await requestJson(`${base}/api/v1/contract/kline/${encodeURIComponent(symbol)}?${params}`);
    if(payload.success!==true) throw new Error(`MEXC kline rejected: ${payload.message??payload.code}`);
    const bars=mexcRowsToBars(payload.data).filter(validBar);
    if(!bars.length) break;
    for(const bar of bars) collected.set(bar.timestamp,bar);
    const newest=Math.max(...bars.map(x=>x.timestamp));
    const next=Math.floor(newest/1000)+intervalSeconds;
    if(next<=cursor) break;
    cursor=next;
    if(cursor>Math.floor(Date.now()/1000)) break;
  }
  const bars=dedupeAndSort([...collected.values()]);
  if(bars.length<count) throw new Error(`MEXC returned only ${bars.length}/${count} unique valid ${interval} bars for ${symbol}`);
  return bars.slice(-count);
}

export function aggregateHourlyTo2h(hourly) {
  const sorted=dedupeAndSort(hourly);
  const groups=new Map();
  for(const bar of sorted){
    const start=Math.floor(bar.timestamp/7200000)*7200000;
    const list=groups.get(start)??[];
    list.push(bar);groups.set(start,list);
  }
  const result=[];
  for(const [timestamp,items] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    items.sort((a,b)=>a.timestamp-b.timestamp);
    if(items.length!==2||items[0].timestamp!==timestamp||items[1].timestamp!==timestamp+3600000) continue;
    result.push({timestamp,open:items[0].open,high:Math.max(...items.map(x=>x.high)),
      low:Math.min(...items.map(x=>x.low)),close:items[1].close,
      volume:items.reduce((sum,x)=>sum+x.volume,0),confirmed:items.every(x=>x.confirmed===true)?true:null});
  }
  return result;
}


export function aggregateHourlyTo1d(hourly) {
  const sorted=dedupeAndSort(hourly);
  const groups=new Map();
  for(const bar of sorted){
    const start=Math.floor(bar.timestamp/86400000)*86400000;
    const list=groups.get(start)??[];
    list.push(bar);groups.set(start,list);
  }
  const result=[];
  for(const [timestamp,items] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    items.sort((a,b)=>a.timestamp-b.timestamp);
    if(items.length!==24) continue;
    let complete=true;
    for(let i=0;i<24;i+=1) if(items[i].timestamp!==timestamp+i*3600000) complete=false;
    if(!complete) continue;
    result.push({timestamp,open:items[0].open,high:Math.max(...items.map(x=>x.high)),
      low:Math.min(...items.map(x=>x.low)),close:items[23].close,
      volume:items.reduce((sum,x)=>sum+x.volume,0),confirmed:items.every(x=>x.confirmed===true)?true:null});
  }
  return result;
}

// Verifies that a selected timeframe has the full, uninterrupted candle history
// required by the indicator calculations. Input must contain closed candles only.
export function assertCandleCoverage(bars, timeframe, requiredCount=1201) {
  const spec=TIMEFRAMES[timeframe];
  if (!spec) throw new Error(`Unsupported timeframe: ${timeframe}`);
  if (!Array.isArray(bars) || bars.length < requiredCount) {
    throw new Error(`${timeframe} history incomplete: ${bars?.length ?? 0}/${requiredCount} closed candles`);
  }
  const selected=bars.slice(-requiredCount);
  const intervalMs=spec.seconds*1000;
  for (let i=0;i<selected.length;i+=1) {
    const bar=selected[i];
    if (!validBar(bar)) throw new Error(`${timeframe} contains an invalid candle at index ${i}`);
    if (bar.confirmed===false) throw new Error(`${timeframe} contains an unclosed candle at index ${i}`);
    if (bar.timestamp % intervalMs !== 0) throw new Error(`${timeframe} candle timestamp is not interval-aligned at index ${i}`);
    if (i>0) {
      const delta=bar.timestamp-selected[i-1].timestamp;
      if (delta!==intervalMs) {
        throw new Error(`${timeframe} candle gap/overlap at index ${i}: expected ${intervalMs}ms, received ${delta}ms`);
      }
    }
  }
  return selected;
}

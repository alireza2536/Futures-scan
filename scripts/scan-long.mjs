import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory, TIMEFRAMES } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { evaluateEntryEligibility, MAX_ENTRY_PRICE_USD } from "./entry-filters.mjs";
import { persistScanResults } from "./persist-neon.mjs";

const CANDLE_COUNT = 1201;
const EMA_LENGTH = 500;
const CCI_LENGTH = 1200;
const VWAP_LENGTH = 1200;
const SELECTED_TIMEFRAMES = ["5m", "15m", "1h", "2h", "4h", "1d"];
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const EXCHANGES = (process.env.EXCHANGES ?? "OKX,MEXC").split(",").map(v=>v.trim().toUpperCase()).filter(Boolean);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 0);
const SYMBOL_FILTER = (process.env.SYMBOLS ?? "").split(",").map(v=>v.trim()).filter(Boolean);
const REQUIRE_DATA = process.env.REQUIRE_DATA === "true";

async function getJson(url) {
  let lastError;
  for (let attempt=0;attempt<5;attempt+=1) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan/0.5"},signal:controller.signal});
      const body=await response.json();
      if(response.status===429) {
        if(attempt===4) throw new Error("HTTP 429 rate limit");
        await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)**2)); continue;
      }
      if(!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0,180)}`);
      return body;
    } catch(error) {
      lastError=error;
      if(attempt===4) break;
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)**2));
    } finally { clearTimeout(timer); }
  }
  throw lastError ?? new Error("Request failed");
}
async function getOkxSymbols(base) {
  const p=await getJson(`${base}/api/v5/public/instruments?instType=SWAP`);
  if(p.code!=="0"||!Array.isArray(p.data)) throw new Error(`OKX instruments rejected: ${p.msg??p.code}`);
  return p.data.filter(x=>x.state==="live"&&x.settleCcy==="USDT").map(x=>({exchange:"OKX",symbol:x.instId,baseAsset:x.baseCcy,base,display:x.instId}));
}
async function getMexcSymbols() {
  const p=await getJson("https://api.mexc.com/api/v1/contract/detail");
  if(p.success!==true||!Array.isArray(p.data)) throw new Error(`MEXC contracts rejected: ${p.message??p.code}`);
  return p.data.filter(x=>x.quoteCoin==="USDT"&&x.settleCoin==="USDT"&&x.state===0&&x.symbol?.endsWith("_USDT"))
    .map(x=>({exchange:"MEXC",symbol:x.symbol,baseAsset:x.baseCoin,display:x.symbol}));
}
async function getOkxPrices(base) {
  const p=await getJson(`${base}/api/v5/market/tickers?instType=SWAP`);
  if(p.code!=="0"||!Array.isArray(p.data)) throw new Error(`OKX tickers rejected: ${p.msg??p.code}`);
  return new Map(p.data.map(x=>[x.instId,Number(x.last)]));
}
async function getMexcPrices() {
  const p=await getJson("https://api.mexc.com/api/v1/contract/ticker");
  if(p.success!==true) throw new Error(`MEXC tickers rejected: ${p.message??p.code}`);
  const rows=Array.isArray(p.data)?p.data:[p.data];
  return new Map(rows.filter(Boolean).map(x=>[x.symbol,Number(x.lastPrice)]));
}
async function mapLimit(items,limit,worker) {
  const output=new Array(items.length); let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const i=next++;if(i>=items.length)return;output[i]=await worker(items[i],i);}
  }));
  return output;
}
function keepClosedCandles(bars,timeframe,now=Date.now()) {
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  return bars.filter(bar=>bar.confirmed===false?false:bar.confirmed===true?true:
    Number.isFinite(bar.timestamp)&&bar.timestamp+intervalMs<=now);
}
async function scanSymbolTimeframe(item,timeframe) {
  try {
    const raw=item.exchange==="OKX"
      ? await fetchOkxHistory({base:item.base,instId:item.symbol,bar:TIMEFRAMES[timeframe].okx,count:CANDLE_COUNT})
      : await fetchMexcHistory({symbol:item.symbol,interval:timeframe,count:CANDLE_COUNT});
    const bars=keepClosedCandles(raw,timeframe);
    if(bars.length<CANDLE_COUNT) throw new Error(`insufficient closed candles ${bars.length}/${CANDLE_COUNT}`);
    const v=calculateLatestIndicators(bars,{emaLength:EMA_LENGTH,cciLength:CCI_LENGTH,vwapLength:VWAP_LENGTH});
    if(![v.close,v.ema9,v.ema21,v.ema,v.cci,v.vwap].every(Number.isFinite)) throw new Error("indicator output contains a missing or non-finite value");
    const ageMs=Date.now()-v.timestamp;
    if(ageMs<0||ageMs>TIMEFRAMES[timeframe].seconds*2000) throw new Error(`stale candle data: ageMs=${ageMs}`);
    return {timeframe,status:"DATA_READY",candleTime:new Date(v.timestamp).toISOString(),close:v.close,ema9:v.ema9,ema21:v.ema21,ema500:v.ema,cci1200:v.cci,vwap1200:v.vwap,candleCount:v.candleCount,candleAgeMs:ageMs};
  } catch(error) { return {timeframe,status:"DATA_ERROR",error:error.message}; }
}
async function scanSymbol(item) {
  const timeframes={};
  for(const tf of SELECTED_TIMEFRAMES) timeframes[tf]=await scanSymbolTimeframe(item,tf);
  const ready=Object.values(timeframes).filter(x=>x.status==="DATA_READY").length;
  return {exchange:item.exchange,symbol:item.display,baseAsset:item.baseAsset,lastPriceUsd:item.lastPriceUsd,
    status:ready===SELECTED_TIMEFRAMES.length?"DATA_READY":ready>0?"PARTIAL_DATA":"DATA_ERROR",timeframes};
}
if(!Number.isInteger(CONCURRENCY)||CONCURRENCY<1||CONCURRENCY>10) throw new Error("CONCURRENCY must be an integer from 1 to 10");
if(EXCHANGES.some(x=>!["OKX","MEXC"].includes(x))) throw new Error("Implemented exchanges currently: OKX, MEXC; other candidate adapters remain unimplemented");
if(!Number.isInteger(MAX_SYMBOLS)||MAX_SYMBOLS<0) throw new Error("MAX_SYMBOLS must be 0 (unlimited) or a positive integer");

const exchangeInputs=await Promise.all(EXCHANGES.map(async exchange=>{
  if(exchange==="OKX") {
    let lastError;
    for(const base of ["https://eea.okx.com","https://openapi.okx.com"]) {
      try {const [symbols,prices]=await Promise.all([getOkxSymbols(base),getOkxPrices(base)]);return {symbols,prices};}
      catch(error){lastError=error;}
    }
    throw lastError??new Error("OKX instruments/tickers unavailable");
  }
  const [symbols,prices]=await Promise.all([getMexcSymbols(),getMexcPrices()]);
  return {symbols,prices};
}));
const candidates=exchangeInputs.flatMap(({symbols,prices})=>symbols.map(x=>({...x,lastPriceUsd:prices.get(x.symbol)})));
const selected=SYMBOL_FILTER.length?candidates.filter(x=>SYMBOL_FILTER.includes(x.symbol)):candidates;
const rejected=[],eligible=[];
for(const item of selected) {
  const d=evaluateEntryEligibility({baseAsset:item.baseAsset,lastPrice:item.lastPriceUsd});
  if(d.eligible) eligible.push(item);
  else rejected.push({exchange:item.exchange,symbol:item.display,baseAsset:item.baseAsset,
    lastPriceUsd:Number.isFinite(item.lastPriceUsd)?item.lastPriceUsd:null,reason:d.reason});
}
const universe=MAX_SYMBOLS>0?eligible.slice(0,MAX_SYMBOLS):eligible;
if(!universe.length) throw new Error("No eligible contracts after stablecoin and <= $30 filters");
console.log(`UNIVERSE | candidates=${selected.length} | eligible=${eligible.length} | scanning=${universe.length}`);
let completed=0;
const results=await mapLimit(universe,CONCURRENCY,async item=>{
  const result=await scanSymbol(item); completed+=1;
  if(completed%10===0||completed===universe.length) console.log(`PROGRESS | ${completed}/${universe.length}`);
  return result;
});
const summary={generatedAt:new Date().toISOString(),purpose:"Market data and indicators only; no long/short rules or trading signals.",
  entryFilters:{excludeStablecoinBaseAssets:true,maximumLastPriceUsd:MAX_ENTRY_PRICE_USD,
    priceSource:"exchange perpetual-contract last traded price; USDT is a USD proxy"},
  exchanges:EXCHANGES,timeframes:SELECTED_TIMEFRAMES,requiredClosedCandles:CANDLE_COUNT,
  candidateCount:selected.length,eligibleBeforeTestCap:eligible.length,rejectedCount:rejected.length,
  scanned:results.length,dataReady:results.filter(x=>x.status==="DATA_READY").length,
  partialData:results.filter(x=>x.status==="PARTIAL_DATA").length,dataErrors:results.filter(x=>x.status==="DATA_ERROR").length,
  rejected,results};
await writeFile("scan-results.json",JSON.stringify(summary,null,2));
const persistence=await persistScanResults(summary);
console.log(`PERSISTENCE | ${persistence.status}`);
console.log(`SUMMARY | scanned=${results.length} | full=${summary.dataReady} | partial=${summary.partialData} | failed=${summary.dataErrors}`);
if(REQUIRE_DATA&&summary.dataErrors+summary.partialData>0) process.exitCode=1;

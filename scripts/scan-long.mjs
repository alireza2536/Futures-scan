import ccxt from "ccxt";
import { writeFile } from "node:fs/promises";
import { fetchOkxHistory, fetchMexcHistory, fetchCcxtHistory } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { isLongSetup, keepClosedFourHourCandles } from "./strategy.mjs";

const CANDLE_COUNT = 1201;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const EXCHANGES = (process.env.EXCHANGES ?? "OKX,MEXC").split(",").map(x => x.trim().toUpperCase()).filter(Boolean);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 0);
const SYMBOL_FILTER = (process.env.SYMBOLS ?? "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean);
const REQUIRE_DATA = process.env.REQUIRE_DATA === "true";
const CONFIG = {
  MEXC:{id:"mexc",direct:true}, BINGX:{id:"bingx"}, OKX:{id:"okx",direct:true},
  WEEX:{id:"weex"}, HTX:{id:"htx"}, KUCOIN:{id:"kucoinfutures"}, XT:{id:"xt"}
};

async function getJson(url) {
  let last;
  for (let i=0;i<5;i++) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan/0.4"},signal:controller.signal});
      const body=await response.json();
      if(response.status===429){if(i===4) throw new Error("HTTP 429 rate limit"); await new Promise(r=>setTimeout(r,1000*(i+1))); continue;}
      if(!response.ok) throw new Error("HTTP "+response.status+": "+JSON.stringify(body).slice(0,180));
      return body;
    } catch(e){last=e;if(i===4) break;await new Promise(r=>setTimeout(r,500*(i+1)));}
    finally{clearTimeout(timer);}
  }
  throw last ?? new Error("Request failed");
}
async function getOkxSymbols() {
  let last;
  for(const base of ["https://eea.okx.com","https://openapi.okx.com"]) try {
    const p=await getJson(base+"/api/v5/public/instruments?instType=SWAP");
    if(p.code!=="0"||!Array.isArray(p.data)) throw new Error("OKX instrument list rejected: "+(p.msg??p.code));
    return p.data.filter(x=>x.state==="live"&&x.settleCcy==="USDT").map(x=>({exchange:"OKX",symbol:x.instId,display:x.instId,base:x.ctValCcy,apiBase:base}));
  } catch(e){last=e;}
  throw last ?? new Error("OKX instrument list unavailable");
}
async function getMexcSymbols() {
  const p=await getJson("https://api.mexc.com/api/v1/contract/detail");
  if(p.success!==true||!Array.isArray(p.data)) throw new Error("MEXC contract list rejected: "+(p.message??p.code));
  return p.data.filter(x=>x.quoteCoin==="USDT"&&x.state===0&&x.symbol?.endsWith("_USDT")).map(x=>({exchange:"MEXC",symbol:x.symbol,display:x.symbol,base:x.baseCoin}));
}
function createClient(config) {
  if(!ccxt.exchanges.includes(config.id)) throw new Error("CCXT adapter missing: "+config.id);
  return new ccxt[config.id]({enableRateLimit:true,timeout:30000,options:{defaultType:"swap"}});
}
async function getCcxtSymbols(label,client) {
  const markets=await client.loadMarkets();
  return Object.values(markets).filter(m=>m&&m.active!==false&&m.contract===true&&m.swap===true&&m.quote==="USDT"&&m.settle==="USDT"&&m.symbol&&m.base)
    .map(m=>({exchange:label,symbol:m.symbol,display:m.symbol,base:m.base,marketId:m.id}));
}
function matchesFilter(item) {
  if(!SYMBOL_FILTER.length) return true;
  const values=[item.symbol,item.display,item.marketId,item.base].filter(Boolean).map(x=>String(x).toUpperCase());
  return SYMBOL_FILTER.some(x=>values.includes(x));
}
async function mapLimit(items,limit,worker) {
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=next++;if(i>=items.length)return;out[i]=await worker(items[i]);}}));
  return out;
}
async function scanSymbol(item,clients) {
  try {
    let raw;
    if(item.exchange==="OKX") raw=await fetchOkxHistory({base:item.apiBase,instId:item.symbol,bar:"4H",count:CANDLE_COUNT});
    else if(item.exchange==="MEXC") raw=await fetchMexcHistory({symbol:item.symbol,interval:"4h",count:CANDLE_COUNT});
    else raw=await fetchCcxtHistory(clients.get(item.exchange),{symbol:item.symbol,interval:"4h",count:CANDLE_COUNT});
    const bars=keepClosedFourHourCandles(raw);
    if(bars.length<1201) throw new Error("not enough closed candles: "+bars.length+"/1201");
    const v=calculateLatestIndicators(bars,{emaLength:500,cciLength:1200});
    const passed=isLongSetup({close:v.close,ema500:v.ema,cci1200:v.cci});
    return {exchange:item.exchange,symbol:item.display,status:passed?"LONG":"NO_MATCH",close:v.close,ema500:v.ema,cci1200:v.cci,candleTime:new Date(v.timestamp).toISOString()};
  } catch(e){return {exchange:item.exchange,symbol:item.display,status:"DATA_ERROR",error:e.message};}
}
if(!Number.isInteger(CONCURRENCY)||CONCURRENCY<1||CONCURRENCY>10) throw new Error("CONCURRENCY must be an integer from 1 to 10");
if(!Number.isInteger(MAX_SYMBOLS)||MAX_SYMBOLS<0) throw new Error("MAX_SYMBOLS must be 0 or a positive integer");
const unknown=EXCHANGES.filter(x=>!CONFIG[x]);
if(unknown.length) throw new Error("Unsupported exchange(s): "+unknown.join(", "));
if(new Set(EXCHANGES).size!==EXCHANGES.length) throw new Error("Duplicate exchange in EXCHANGES");

const clients=new Map();
try {
  const lists=await Promise.all(EXCHANGES.map(async label=>{
    const cfg=CONFIG[label];
    if(cfg.direct) return label==="OKX"?getOkxSymbols():getMexcSymbols();
    const client=createClient(cfg);clients.set(label,client);return getCcxtSymbols(label,client);
  }));
  const filtered=lists.map(list=>list.filter(matchesFilter));
  const universe=filtered.flatMap(list=>MAX_SYMBOLS>0?list.slice(0,MAX_SYMBOLS):list);
  if(!universe.length) throw new Error("No matching active USDT-settled crypto perpetual contracts found");
  console.log("UNIVERSE | "+universe.length+" USDT perpetual contracts | exchanges="+EXCHANGES.join(",")+" | concurrency="+CONCURRENCY+" | maxSymbolsPerExchange="+MAX_SYMBOLS);
  EXCHANGES.forEach((name,i)=>console.log("EXCHANGE_UNIVERSE | "+name+" | "+filtered[i].length+" eligible contracts"));
  let done=0;
  const results=await mapLimit(universe,CONCURRENCY,async item=>{
    const r=await scanSymbol(item,clients);done++;
    if(done%25===0||done===universe.length) console.log("PROGRESS | "+done+"/"+universe.length);
    return r;
  });
  const matches=results.filter(x=>x.status==="LONG"),errors=results.filter(x=>x.status==="DATA_ERROR");
  const summary={generatedAt:new Date().toISOString(),rule:"4h close > EMA500 AND CCI(1200) > 100",exchanges:EXCHANGES,scanned:results.length,longMatches:matches.length,dataErrors:errors.length,matches,errors};
  await writeFile("scan-results.json",JSON.stringify(summary,null,2));
  console.log("SUMMARY | scanned="+results.length+" | LONG="+matches.length+" | DATA_ERROR="+errors.length);
  console.log("RESULT_FILE | scan-results.json");
  if(REQUIRE_DATA&&errors.length) process.exitCode=1;
} finally {
  await Promise.all([...clients.values()].map(async c=>{try{await c.close();}catch{}}));
}

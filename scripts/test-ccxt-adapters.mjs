import assert from "node:assert/strict";
import { createCcxtAdapter, fetchCcxtHistory, supportedCcxtExchanges } from "./ccxt-adapters.mjs";
import { TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const names=supportedCcxtExchanges();
assert.deepEqual(names,["BINGX","WEEX","HTX","KUCOIN","XT"]);
const timeframe=process.env.LIVE_TIMEFRAME??"5m";
const count=1203;
const report=[];
for(const name of names){
  let adapter;
  try{
    adapter=await createCcxtAdapter(name);
    const sample=adapter.symbols.find(x=>x.baseAsset==="BTC"&&Number.isFinite(x.lastPriceUsd));
    if(!sample) throw new Error("BTC/USDT linear perpetual market or ticker unavailable");
    const bars=await fetchCcxtHistory({client:adapter.client,symbol:sample.symbol,timeframe,count});
    const closed=bars.filter(b=>b.timestamp+TIMEFRAMES[timeframe].seconds*1000<=Date.now());
    const verified=assertCandleCoverage(closed,timeframe,count);
    const indicators=calculateLatestIndicators(verified,{emaLength:500,cciLength:1200});
    for(const key of ["ema9","ema21","ema","cci","vwap","close"]) assert.ok(Number.isFinite(indicators[key]),`non-finite ${key}`);
    report.push({exchange:name,status:"PASS",symbol:sample.symbol,candles:verified.length,timeframe});
  }catch(error){report.push({exchange:name,status:"FAIL",error:error.message});}
  finally{await adapter?.client?.close?.();}
}
for(const row of report) console.log(JSON.stringify(row));
if(report.some(x=>x.status!=="PASS")) process.exitCode=1;

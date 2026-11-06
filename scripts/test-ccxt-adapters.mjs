import assert from "node:assert/strict";
import { createCcxtAdapter, fetchCcxtHistory, supportedCcxtExchanges } from "./ccxt-adapters.mjs";
import { TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const names=supportedCcxtExchanges();
assert.deepEqual(names,["BINGX","WEEX","KUCOIN","XT"]);
const timeframeNames=Object.keys(TIMEFRAMES);
const count=1203;
const report=[];
for(const name of names){
  let adapter;
  try{
    adapter=await createCcxtAdapter(name);
    const sample=adapter.symbols.find(x=>x.baseAsset==="BTC"&&Number.isFinite(x.lastPriceUsd));
    if(!sample) throw new Error("BTC/USDT linear perpetual market or valid ticker unavailable");
    for(const timeframe of timeframeNames){
      try{
        const bars=await fetchCcxtHistory({client:adapter.client,symbol:sample.symbol,timeframe,count});
        const closed=bars.filter(b=>b.timestamp+TIMEFRAMES[timeframe].seconds*1000<=Date.now()).slice(-1201);
        const verified=assertCandleCoverage(closed,timeframe,1201);
        const indicators=calculateLatestIndicators(verified,{emaLength:500,cciLength:1200});
        for(const key of ["ema9","ema21","ema","cci","vwap","close"]) assert.ok(Number.isFinite(indicators[key]),`non-finite ${key}`);
        const ageMs=Date.now()-verified.at(-1).timestamp;
        if(ageMs<0||ageMs>TIMEFRAMES[timeframe].seconds*2) throw new Error(`stale last candle age=${ageMs}ms`);
        report.push({exchange:name,timeframe,status:"PASS",symbol:sample.symbol,candles:verified.length,lastCandleAt:new Date(verified.at(-1).timestamp).toISOString()});
      }catch(error){report.push({exchange:name,timeframe,status:"FAIL",error:error.message});}
    }
  }catch(error){
    for(const timeframe of timeframeNames) report.push({exchange:name,timeframe,status:"FAIL",error:error.message});
  }finally{await adapter?.client?.close?.();}
}
for(const row of report) console.log(JSON.stringify(row));
const passed=report.filter(x=>x.status==="PASS").length;
console.log(JSON.stringify({test:"four-exchange-six-timeframe-live-validation",passed,failed:report.length-passed,total:report.length,generatedAt:new Date().toISOString()}));
if(report.some(x=>x.status!=="PASS")) process.exitCode=1;

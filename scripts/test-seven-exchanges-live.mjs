import { fetchOkxHistory, fetchMexcHistory, TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";
import { createCcxtAdapter, fetchCcxtHistory } from "./ccxt-adapters.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const COUNT=1203, CCI_LENGTH=1000;
const TIMEFRAME_NAMES=Object.keys(TIMEFRAMES);
const results=[];
async function verify(exchange,timeframe,fetcher){
  try{
    const raw=await fetcher();
    const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
    const closed=raw.filter(bar=>bar.confirmed===false?false:
      bar.confirmed===true?true:Number.isFinite(bar.timestamp)&&bar.timestamp+intervalMs<=Date.now()).slice(-1201);
    const bars=assertCandleCoverage(closed,timeframe,1201);
    const values=calculateLatestIndicators(bars,{cciLength:CCI_LENGTH});
    for(const key of ["close","ema9","ema20","ema21","ema50","cci","vwap"]){
      if(!Number.isFinite(values[key])) throw new Error("non-finite "+key);
    }
    const age=Date.now()-(bars.at(-1).timestamp+intervalMs);
    if(age<0||age>intervalMs*2) throw new Error("stale last closed candle: "+age+"ms");
    return {exchange,timeframe,status:"PASS",closedCandles:bars.length,lastClosedAt:new Date(bars.at(-1).timestamp).toISOString(),cciLength:CCI_LENGTH};
  }catch(error){return {exchange,timeframe,status:"FAIL",error:error.message};}
}
for(const timeframe of TIMEFRAME_NAMES){
  results.push(await verify("OKX",timeframe,()=>fetchOkxHistory({
    base:process.env.OKX_BASE_URL??"https://openapi.okx.com",instId:"BTC-USDT-SWAP",
    bar:TIMEFRAMES[timeframe].okx,count:COUNT
  })));
  results.push(await verify("MEXC",timeframe,()=>fetchMexcHistory({
    base:process.env.MEXC_BASE_URL??"https://api.mexc.com",symbol:"BTC_USDT",interval:timeframe,count:COUNT
  })));
}
for(const exchange of ["BINGX","WEEX","KUCOIN","XT"]){
  let adapter;
  try{
    adapter=await createCcxtAdapter(exchange);
    const btc=adapter.symbols.find(x=>x.baseAsset==="BTC"&&Number.isFinite(x.lastPriceUsd));
    if(!btc) throw new Error("BTC USDT linear perpetual ticker unavailable");
    for(const timeframe of TIMEFRAME_NAMES){
      results.push(await verify(exchange,timeframe,()=>fetchCcxtHistory({
        client:adapter.client,symbol:btc.symbol,timeframe,count:COUNT
      })));
    }
  }catch(error){
    for(const timeframe of TIMEFRAME_NAMES){
      if(!results.some(x=>x.exchange===exchange&&x.timeframe===timeframe))
        results.push({exchange,timeframe,status:"FAIL",error:error.message});
    }
  }finally{await adapter?.client?.close?.();}
}
for(const row of results) console.log(JSON.stringify(row));
const passed=results.filter(x=>x.status==="PASS").length;
const failed=results.length-passed;
console.log(JSON.stringify({test:"six-exchange-six-timeframe-live-validation",passed,failed,total:results.length,generatedAt:new Date().toISOString()}));
if(failed>0) process.exitCode=1;

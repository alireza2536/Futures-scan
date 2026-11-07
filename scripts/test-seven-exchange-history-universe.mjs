import ccxt from "ccxt";
import fs from "node:fs";
import { createCcxtAdapter, fetchCcxtHistory, supportedCcxtExchanges } from "./ccxt-adapters.mjs";
import { fetchOkxHistory, fetchMexcHistory, TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";
import { evaluateEntryEligibility } from "./entry-filters.mjs";

const EXCHANGES=["OKX","MEXC",...supportedCcxtExchanges()];
const exchangeName=String(process.env.EXCHANGE??"").toUpperCase();
if(!EXCHANGES.includes(exchangeName)) throw new Error("Set EXCHANGE to one of: "+EXCHANGES.join(", "));
const COUNT=1203, REQUIRED_CLOSED=1201, CCI_LENGTH=1000, TIMEFRAME_NAMES=Object.keys(TIMEFRAMES);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reportPath=`history-universe-${exchangeName}.jsonl`;
fs.writeFileSync(reportPath,"");
function log(row){const line=JSON.stringify(row);console.log(line);fs.appendFileSync(reportPath,line+"\n");}
function isClosed(bar,timeframe){
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  return bar.confirmed===false?false:bar.confirmed===true?true:
    Number.isFinite(bar.timestamp)&&bar.timestamp+intervalMs<=Date.now();
}
async function loadUniverse(){
  if(exchangeName!=="OKX"&&exchangeName!=="MEXC"){
    const adapter=await createCcxtAdapter(exchangeName);
    return {client:adapter.client,markets:adapter.symbols.map(x=>({symbol:x.symbol,id:adapter.client.market(x.symbol).id,baseAsset:x.baseAsset,lastPrice:x.lastPriceUsd,marketInfo:x.marketInfo}))};
  }
  const id=exchangeName==="OKX"?"okx":"mexc";
  const Exchange=ccxt[id];
  if(!Exchange) throw new Error("CCXT does not provide "+id);
  const client=new Exchange({enableRateLimit:true,timeout:30000,options:{defaultType:"swap"}});
  await client.loadMarkets();
  const markets=Object.values(client.markets).filter(m=>m.active!==false&&m.swap===true&&m.linear===true&&m.quote==="USDT"&&m.settle==="USDT"&&m.base&&m.symbol);
  let tickers;
  try{tickers=await client.fetchTickers(markets.map(m=>m.symbol));}
  catch{tickers=await client.fetchTickers();}
  return {client,markets:markets.map(m=>({symbol:m.symbol,id:m.id,baseAsset:m.base,lastPrice:Number(tickers?.[m.symbol]?.last),marketInfo:m.info}))};
}
async function fetchHistory(client,market,timeframe){
  if(exchangeName==="OKX") return fetchOkxHistory({base:process.env.OKX_BASE_URL??"https://openapi.okx.com",instId:market.id,bar:TIMEFRAMES[timeframe].okx,count:COUNT});
  if(exchangeName==="MEXC") return fetchMexcHistory({base:process.env.MEXC_BASE_URL??"https://api.mexc.com",symbol:market.id,interval:timeframe,count:COUNT});
  return fetchCcxtHistory({client,symbol:market.symbol,timeframe,count:COUNT});
}
let client;
const results=[];
try{
  const loaded=await loadUniverse();client=loaded.client;
  const eligible=loaded.markets.filter(m=>evaluateEntryEligibility({baseAsset:m.baseAsset,lastPrice:m.lastPrice,marketInfo:m.marketInfo}).eligible);
  console.log(JSON.stringify({event:"universe-loaded",exchange:exchangeName,activeUsdtPerpetuals:loaded.markets.length,eligibleSymbols:eligible.length,timeframes:TIMEFRAME_NAMES,requiredClosedCandles:REQUIRED_CLOSED}));
  for(let index=0;index<eligible.length;index+=1){
    const market=eligible[index];
    for(const timeframe of TIMEFRAME_NAMES){
      try{
        const raw=await fetchHistory(client,market,timeframe);
        const closed=raw.filter(bar=>isClosed(bar,timeframe)).slice(-REQUIRED_CLOSED);
        const bars=assertCandleCoverage(closed,timeframe,REQUIRED_CLOSED);
        const values=calculateLatestIndicators(bars,{cciLength:CCI_LENGTH});
        for(const key of ["close","ema9","ema20","ema21","ema50","cci","vwap"]){
          if(!Number.isFinite(values[key])) throw new Error("non-finite "+key);
        }
        const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
        const age=Date.now()-(bars.at(-1).timestamp+intervalMs);
        if(age<0||age>intervalMs*2) throw new Error("stale last closed candle: "+age+"ms");
        log({exchange:exchangeName,symbol:market.symbol,baseAsset:market.baseAsset,timeframe,status:"PASS",closedCandles:bars.length,lastClosedAt:new Date(bars.at(-1).timestamp).toISOString(),cciLength:CCI_LENGTH});
      }catch(error){
        log({exchange:exchangeName,symbol:market.symbol,baseAsset:market.baseAsset,timeframe,status:"FAIL",error:error.message});
      }
      await sleep(250);
    }
    if((index+1)%25===0||index+1===eligible.length){
      console.log(JSON.stringify({event:"progress",exchange:exchangeName,completedSymbols:index+1,totalSymbols:eligible.length,completedCases:(index+1)*TIMEFRAME_NAMES.length,totalCases:eligible.length*TIMEFRAME_NAMES.length}));
    }
  }
}finally{await client?.close?.();}
const lines=fs.readFileSync(reportPath,"utf8").trim().split("\n").filter(Boolean);
for(const line of lines){const row=JSON.parse(line);if(row.status)results.push(row);}
const passed=results.filter(x=>x.status==="PASS").length,failed=results.length-passed;
const summary={test:"all-eligible-symbols-six-timeframe-history-and-indicator-validation",exchange:exchangeName,passed,failed,total:results.length,generatedAt:new Date().toISOString(),reportPath};
fs.writeFileSync(`history-universe-${exchangeName}-summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
if(failed>0)process.exitCode=1;

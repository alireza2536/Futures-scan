import { createCcxtAdapter, supportedCcxtExchanges } from "./ccxt-adapters.mjs";
import { evaluateEntryEligibility, isNonCryptoMarket } from "./entry-filters.mjs";

const REQUIRED=["OKX","MEXC",...supportedCcxtExchanges()];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url){
  let last;
  for(let i=0;i<5;i+=1){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const r=await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan-universe-audit/1.0"},signal:controller.signal});
      const body=await r.json();
      if(r.status===429){if(i===4)throw new Error("HTTP 429 rate limit");await sleep(1000*(i+1)**2);continue;}
      if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(body).slice(0,160));
      return body;
    }catch(e){last=e;if(i===4)break;await sleep(500*(i+1)**2);}
    finally{clearTimeout(timer);}
  }
  throw last??new Error("Public API request failed");
}
async function okxUniverse(){
  let last;
  for(const base of ["https://eea.okx.com","https://openapi.okx.com"]){
    try{
      const [instruments,tickers]=await Promise.all([
        json(base+"/api/v5/public/instruments?instType=SWAP"),
        json(base+"/api/v5/market/tickers?instType=SWAP")
      ]);
      if(instruments.code!=="0"||!Array.isArray(instruments.data))throw new Error("OKX instrument catalog rejected: "+instruments.msg);
      if(tickers.code!=="0"||!Array.isArray(tickers.data))throw new Error("OKX ticker catalog rejected: "+tickers.msg);
      const active=instruments.data.filter(x=>x.state==="live"&&x.settleCcy==="USDT"&&x.instId?.endsWith("-SWAP"));
      const prices=new Map(tickers.data.map(x=>[x.instId,Number(x.last)]));
      return active.map(x=>({symbol:x.instId,baseAsset:x.baseCcy||x.instId.split("-")[0],price:prices.get(x.instId),quote:x.quoteCcy||"USDT",settle:x.settleCcy,active:true,marketInfo:x}));
    }catch(e){last=e;}
  }
  throw last??new Error("OKX universe unavailable");
}
async function mexcUniverse(){
  const [contracts,tickers]=await Promise.all([
    json("https://api.mexc.com/api/v1/contract/detail"),
    json("https://api.mexc.com/api/v1/contract/ticker")
  ]);
  if(contracts.success!==true||!Array.isArray(contracts.data))throw new Error("MEXC contract catalog rejected: "+contracts.message);
  if(tickers.success!==true)throw new Error("MEXC ticker catalog rejected: "+tickers.message);
  const rows=Array.isArray(tickers.data)?tickers.data:[tickers.data];
  const prices=new Map(rows.filter(Boolean).map(x=>[x.symbol,Number(x.lastPrice)]));
  return contracts.data.filter(x=>x.quoteCoin==="USDT"&&x.settleCoin==="USDT"&&x.state===0&&x.symbol?.endsWith("_USDT"))
    .map(x=>({symbol:x.symbol,baseAsset:x.baseCoin,price:prices.get(x.symbol),quote:x.quoteCoin,settle:x.settleCoin,active:true,marketInfo:x}));
}
const clients=[];
const results=[];
try{
  for(const name of REQUIRED){
    try{
      let markets;
      if(name==="OKX") markets=await okxUniverse();
      else if(name==="MEXC") markets=await mexcUniverse();
      else{
        const adapter=await createCcxtAdapter(name);
        clients.push(adapter.client);
        markets=adapter.symbols.map(x=>({symbol:x.symbol,baseAsset:x.baseAsset,price:x.lastPriceUsd,quote:"USDT",settle:"USDT",active:true,marketType:x.marketType,marketSubtype:x.marketSubtype,contract:x.contract,swap:x.swap,linear:x.linear,marketInfo:x.marketInfo}));
      }
      const unique=new Set(markets.map(x=>x.symbol));
      const duplicates=markets.length-unique.size;
      const invalid=markets.filter(x=>!x.symbol||!x.baseAsset||x.quote!=="USDT"||x.settle!=="USDT"||!x.active);
      const missingPrices=markets.filter(x=>!Number.isFinite(x.price)||x.price<=0);
      const eligible=markets.filter(x=>evaluateEntryEligibility({baseAsset:x.baseAsset,lastPrice:x.price,marketInfo:x.marketInfo}).eligible);
      const rejected=markets.length-eligible.length;
      const nonCrypto=markets.filter(x=>isNonCryptoMarket({baseAsset:x.baseAsset,marketInfo:x.marketInfo}));
      const ambiguousGas=markets.filter(x=>x.baseAsset==="GAS").map(x=>({symbol:x.symbol,marketType:x.marketType,marketSubtype:x.marketSubtype,contract:x.contract,swap:x.swap,linear:x.linear,marketInfo:x.marketInfo}));
      const pass=markets.length>0&&duplicates===0&&invalid.length===0;
      const row={exchange:name,status:pass?(missingPrices.length?"PASS_WITH_MISSING_TICKERS_EXCLUDED":"PASS"):"FAIL",activeUsdtPerpetuals:markets.length,uniqueSymbols:unique.size,
        duplicateSymbols:duplicates,invalidContractMetadata:invalid.length,missingOrInvalidTickers:missingPrices.length,missingTickerExamples:missingPrices.slice(0,12).map(x=>x.symbol),
        eligibleAfterApprovedFilters:eligible.length,rejectedByApprovedFilters:rejected,excludedNonCryptoUnderlyings:nonCrypto.length,nonCryptoExamples:nonCrypto.slice(0,20).map(x=>x.symbol),ambiguousGasMetadata:ambiguousGas,
        filterRule:"exclude stablecoin and non-crypto underlyings; include last price <= 30 USD; missing/nonpositive price rejected",
        sampleSymbols:markets.slice(0,5).map(x=>x.symbol)};
      results.push(row);
      console.log(JSON.stringify(row));
    }catch(error){
      const row={exchange:name,status:"FAIL",error:error.message};
      results.push(row);console.log(JSON.stringify(row));
    }
  }
}finally{
  await Promise.all(clients.map(client=>client.close?.()));
}
const passed=results.filter(x=>x.status==="PASS"||x.status==="PASS_WITH_MISSING_TICKERS_EXCLUDED").length;
const failed=results.length-passed;
console.log(JSON.stringify({test:"all-six-full-usdt-perpetual-universe-and-ticker-audit",passed,failed,total:results.length,generatedAt:new Date().toISOString()}));
if(failed)process.exitCode=1;

const headers={accept:"application/json","user-agent":"Futures-scan-WEEX-full-universe-audit/1.0"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){
 let last;
 for(let attempt=0;attempt<5;attempt++){
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
   const raw=await r.text(); let j; try{j=JSON.parse(raw)}catch{throw new Error("non-JSON HTTP "+r.status+": "+raw.slice(0,120))}
   if(r.status===429||r.status>=500){if(attempt===4)throw new Error("HTTP "+r.status);await sleep(1500*(attempt+1));continue;}
   if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(j).slice(0,160));
   return j;
  }catch(e){last=e;if(attempt===4)break;await sleep(1000*(attempt+1));}
 }
 throw last??new Error("request failed");
}
async function mapLimit(items,limit,fn){
 const out=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch(e){out[i]={symbol:items[i],ok:false,error:String(e.message||e)}}}
 }));
 return out;
}
const base="https://api-contract.weex.com/capi/v3/market";
const [catalog,tradfi,apiTrading]=await Promise.all([
 getJson(base+"/exchangeInfo?contractType=PERPETUAL"),
 getJson(base+"/exchangeInfo?contractType=TRADIFI_PERPETUAL"),
 getJson(base+"/apiTradingSymbols")
]);
if(!Array.isArray(catalog?.symbols)||!Array.isArray(tradfi?.symbols)||!Array.isArray(apiTrading))throw new Error("WEEX contract/tradfi/tradable catalog schema invalid");
const tradfiSet=new Set(tradfi.symbols.map(x=>String(x?.symbol??"").toUpperCase()).filter(Boolean));
const tradableSet=new Set(apiTrading.map(x=>String(x).toUpperCase()).filter(Boolean));
const statusCounts={};
let statusFieldPresent=0;
for(const row of catalog.symbols){const s=String(row?.status??"").toUpperCase();if(s)statusFieldPresent++;statusCounts[s||"MISSING"]=(statusCounts[s||"MISSING"]||0)+1;}
const contractCandidates=catalog.symbols.filter(row=>{
 const symbol=String(row?.symbol??"");
 const status=String(row?.status??"").toUpperCase();
 return row?.contractType==="PERPETUAL"&&
 String(row?.underlyingType??"").toUpperCase()==="COIN"&&
 symbol.toUpperCase().endsWith("USDT")&&
 !tradfiSet.has(symbol.toUpperCase())&&
 tradableSet.has(symbol.toUpperCase())&&
 (!status||["TRADING","OPEN","1"].includes(status))&&
 String(row?.marginAsset??row?.quoteAsset??"USDT").toUpperCase()==="USDT";
});
const symbols=[...new Set(contractCandidates.map(x=>String(x.symbol)))];
const oiResults=await mapLimit(symbols,4,async symbol=>{
 const url=base+"/openInterest?symbol="+encodeURIComponent(symbol);
 const j=await getJson(url);
 const value=Number(j?.openInterest);
 if(!Number.isFinite(value)||value<=0)throw new Error("missing/non-positive openInterest; keys="+Object.keys(j??{}).join(","));
 return {symbol,ok:true,openInterest:value};
});
const passed=oiResults.filter(x=>x?.ok).length;
const failed=oiResults.filter(x=>!x?.ok);
const eligibleSet=new Set(symbols.map(x=>x.toUpperCase()));
const eligibleNotInApiTrading=symbols.filter(s=>!tradableSet.has(s.toUpperCase()));
const tradableNotEligible=[...tradableSet].filter(s=>!eligibleSet.has(s));
const tradableTradfiOverlap=tradableNotEligible.filter(s=>tradfiSet.has(s));
const tradableUnclassified=tradableNotEligible.filter(s=>!tradfiSet.has(s));
const report={
 generatedAt:new Date().toISOString(),
 catalogs:{perpetualRows:catalog.symbols.length,tradfiRows:tradfi.symbols.length,apiTradingSymbols:apiTrading.length,statusFieldPresent,statusFieldMissing:catalog.symbols.length-statusFieldPresent,statusCounts},
 filtering:{tradfiSymbolsExcluded:tradfiSet.size,contractCandidates:contractCandidates.length,uniqueEligibleSymbols:symbols.length,eligibleNotInApiTrading:eligibleNotInApiTrading.length,tradableNotEligible:tradableNotEligible.length,tradableTradfiOverlap:tradableTradfiOverlap.length,tradableUnclassified:tradableUnclassified.length,unclassifiedExamples:tradableUnclassified.slice(0,30)},
 openInterest:{requested:symbols.length,passed,failed:failed.length,failedSymbols:failed},
 result:symbols.length>0&&passed===symbols.length&&eligibleNotInApiTrading.length===0&&tradableUnclassified.length===0?"PASS":"FAIL"
};
await (await import("node:fs/promises")).writeFile("weex-full-universe-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=="PASS")process.exitCode=1;

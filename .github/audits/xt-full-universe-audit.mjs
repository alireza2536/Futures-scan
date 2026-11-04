const headers={accept:"application/json","user-agent":"Futures-scan-XT-full-universe-audit/1.0"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){
 let last;
 for(let attempt=0;attempt<5;attempt++){
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
   const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error("non-JSON HTTP "+r.status+": "+raw.slice(0,120))}
   if(r.status===429||r.status>=500){if(attempt===4)throw new Error("HTTP "+r.status);await sleep(1000*(attempt+1));continue;}
   if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(j).slice(0,160));
   return j;
  }catch(e){last=e;if(attempt===4)break;await sleep(700*(attempt+1));}
 }
 throw last??new Error("XT request failed");
}
async function mapLimit(items,limit,fn){
 const out=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch(e){out[i]={symbol:items[i],ok:false,error:String(e.message||e)}}}
 }));
 return out;
}
const [catalog,plates]=await Promise.all([
 getJson("https://fapi.xt.com/future/market/v1/public/symbol/list"),
 getJson("https://fapi.xt.com/future/market/v1/public/plate/list")
]);
if(catalog.returnCode!==0||!Array.isArray(catalog.result)||plates.returnCode!==0||!Array.isArray(plates.result))throw new Error("XT catalog/plate API schema invalid");
const nonCryptoNames=/^(tradfi|forex|tokenized stocks|commodities|index|indices|pre.?market)$/i;
const tradfiPlates=plates.result.filter(row=>nonCryptoNames.test(String(row.plate??row.name??"").trim())).map(row=>({id:Number(row.id),name:String(row.plate??row.name??"").trim()})).filter(x=>Number.isFinite(x.id));
if(!tradfiPlates.length)throw new Error("No official XT TradFi plate IDs; fail closed");
const tradfiIds=new Set(tradfiPlates.map(x=>x.id));
const active=catalog.result.filter(row=>String(row.symbol??"").toLowerCase().endsWith("_usdt")&&row.tradeSwitch===true&&String(row.settleCoin??row.quoteCoin??"USDT").toUpperCase()==="USDT");
const missingPlates=active.filter(row=>!Array.isArray(row.plates));
const tradfi=active.filter(row=>Array.isArray(row.plates)&&row.plates.some(id=>tradfiIds.has(Number(id))));
const metadataOnly=active.filter(row=>Array.isArray(row.plates)&&!row.plates.some(id=>tradfiIds.has(Number(id)))&&/^(tradfi|stock|stocks|equity|forex|commodity|commodities|index|indices|metal|metals|energy|etf|premarket)$/i.test(String(row.assetClass??row.assetType??row.category??"")));
const crypto=active.filter(row=>Array.isArray(row.plates)&&!row.plates.some(id=>tradfiIds.has(Number(id)))&&!metadataOnly.includes(row));
const symbols=[...new Set(crypto.map(row=>String(row.symbol)))];
const results=await mapLimit(symbols,8,async symbol=>{
 const j=await getJson("https://fapi.xt.com/future/market/v1/public/contract/open-interest?symbol="+encodeURIComponent(symbol));
 if(j.returnCode!==0)throw new Error("returnCode "+j.returnCode);
 const value=Number(j.result?.openInterest??j.result?.openInterestUsd);
 if(!Number.isFinite(value)||value<=0)throw new Error("missing/non-positive OI; keys="+Object.keys(j.result??{}).join(","));
 return {symbol,ok:true,openInterest:value};
});
const passed=results.filter(x=>x?.ok).length;
const failed=results.filter(x=>!x?.ok);
const report={generatedAt:new Date().toISOString(),catalog:{totalRows:catalog.result.length,activeUsdt:active.length,tradfiPlates,excludedByOfficialPlate:tradfi.length,excludedByMetadataOnly:metadataOnly.length,missingPlateMetadata:missingPlates.length,cryptoCandidates:symbols.length},openInterest:{requested:symbols.length,passed,failed:failed.length,failedSymbols:failed},result:symbols.length>0&&missingPlates.length===0&&passed===symbols.length?"PASS":"FAIL"};
await (await import("node:fs/promises")).writeFile("xt-full-universe-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=="PASS")process.exitCode=1;

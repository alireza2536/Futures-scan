const headers={accept:"application/json","user-agent":"Futures-scan-WEEX-symbol-diff-audit/1.0"};
async function getJson(url){const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error("non-json "+r.status+" "+raw.slice(0,120))}if(!r.ok)throw new Error("HTTP "+r.status);return j;}
const base="https://api-contract.weex.com/capi/v3/market";
const [perp,tradfi,api]=await Promise.all([getJson(base+"/exchangeInfo?contractType=PERPETUAL"),getJson(base+"/exchangeInfo?contractType=TRADIFI_PERPETUAL"),getJson(base+"/apiTradingSymbols")]);
const perpRows=perp.symbols??[],tradfiRows=tradfi.symbols??[];
const perpSet=new Set(perpRows.map(x=>String(x.symbol).toUpperCase()));
const tradfiSet=new Set(tradfiRows.map(x=>String(x.symbol).toUpperCase()));
const apiSet=new Set(api.map(x=>String(x).toUpperCase()));
const missing=[...apiSet].filter(x=>!perpSet.has(x)&&!tradfiSet.has(x));
const results=[];
for(let i=0;i<missing.length;i+=10){
 const batch=missing.slice(i,i+10);
 const rs=await Promise.all(batch.map(async symbol=>{
  const normalized=symbol.replace(/SUSDT$/,"USDT");
  try{
   const [info,oi,normalizedOi]=await Promise.all([
    getJson(base+"/exchangeInfo?symbol="+encodeURIComponent(symbol)).catch(e=>({lookupError:String(e.message||e)})),
    getJson(base+"/openInterest?symbol="+encodeURIComponent(symbol)).catch(e=>({oiError:String(e.message||e)})),
    normalized!==symbol?getJson(base+"/openInterest?symbol="+encodeURIComponent(normalized)).catch(e=>({oiError:String(e.message||e)})):Promise.resolve({})
   ]);
   return {
    symbol,normalizedAlias:normalized,normalizedAliasInPerpetualCatalog:perpSet.has(normalized),
    normalizedAliasInTradfiCatalog:tradfiSet.has(normalized),
    infoRows:(info.symbols??[]).map(x=>({symbol:x.symbol,contractType:x.contractType,underlyingType:x.underlyingType,underlyingSubType:x.underlyingSubType,marginAsset:x.marginAsset,quoteAsset:x.quoteAsset,forwardContractFlag:x.forwardContractFlag})),
    infoError:info.lookupError??null,oiError:oi.oiError??null,
    oiSymbol:oi.symbol??null,openInterest:oi.openInterest??null,
    normalizedOiError:normalizedOi.oiError??null,normalizedOiSymbol:normalizedOi.symbol??null,
    normalizedOpenInterest:normalizedOi.openInterest??null
   };
  }catch(e){return {symbol,error:String(e.message||e)}}
 }));
 results.push(...rs);
}
const report={generatedAt:new Date().toISOString(),counts:{perpetualCatalog:perpRows.length,tradfiCatalog:tradfiRows.length,apiTradingSymbols:apiSet.size,missingFromBothCatalogs:missing.length,normalizedAliasesInCatalog:results.filter(x=>x.normalizedAliasInPerpetualCatalog||x.normalizedAliasInTradfiCatalog).length,oiEndpointSuccess:results.filter(x=>Number(x.openInterest)>0).length},missingSymbols:missing,lookupResults:results};
await (await import("node:fs/promises")).writeFile("weex-symbol-diff-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));

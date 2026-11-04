const headers={accept:"application/json","user-agent":"Futures-scan-BingX-full-universe-audit/1.0"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){
 let last;
 for(let attempt=0;attempt<6;attempt++){
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
   const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error("non-JSON HTTP "+r.status+": "+raw.slice(0,120))}
   if(r.status===429||j?.code===100001||r.status>=500){if(attempt===5)throw new Error("HTTP/API rate limit "+r.status+" code="+j?.code);await sleep(Math.min(10000*(attempt+1),45000));continue;}
   if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(j).slice(0,160));
   return j;
  }catch(e){last=e;if(attempt===5)break;await sleep(1500*(attempt+1));}
 }
 throw last??new Error("BingX request failed");
}
function isTradfi(row){
 const fields=[row?.assetClass,row?.asset_class,row?.assetType,row?.asset_type,row?.baseAssetType,row?.baseAssetSubType,row?.base_asset_type,row?.base_asset_sub_type,row?.marketType,row?.market_type,row?.businessType,row?.business_type,row?.productType,row?.product_type,row?.category,row?.symbolType,row?.symbol_type,row?.instrumentType,row?.instrument_type,row?.underlyingType,row?.underlying_type];
 const normalized=fields.filter(v=>v!==null&&v!==undefined&&String(v).trim()!=="").map(v=>String(v).trim().toLowerCase().replace(/[\\s_-]+/g,""));
 const names=[row?.baseCoinName,row?.baseCoinNameEn,row?.enName,row?.enDesc,row?.cnName,row?.cnDesc,row?.displayName,row?.description].filter(v=>v!==null&&v!==undefined&&String(v).trim()!=="").map(v=>String(v).trim().toLowerCase());
 return normalized.some(v=>/^(tradfi|traditionalfinance|stock|stocks|equity|equities|forex|fx|commodity|commodities|index|indices|metal|metals|energy)$/.test(v))||names.some(v=>/(stock|equity|share|forex|commodity|commodities|indices|index|metal|metals|gold|silver|crude|oil|natural gas|sp500|s&p|nasdaq|dow jones|nikkei|jp225|us30)/i.test(v));
}
function bingxTradfiSymbol(symbol){const base=String(symbol??"").split("-")[0].toUpperCase();return /^(NCS|NCCO|NCF)/.test(base);}
const catalog=await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/contracts");
if(!(catalog.code===0||catalog.code==="0")||!Array.isArray(catalog.data))throw new Error("BingX contract catalog schema invalid");
const active=catalog.data.filter(row=>{
 const symbol=String(row?.symbol??"");
 const status=String(row?.status??"").toUpperCase();
 return symbol.toUpperCase().endsWith("-USDT")&&!isTradfi(row)&&!bingxTradfiSymbol(symbol)&&(!status||["TRADING","ACTIVE","ONLINE","1"].includes(status));
});
const symbols=[...new Set(active.map(row=>String(row.symbol)))];
const results=[];let lastRequestAt=0;
for(let i=0;i<symbols.length;i++){
 const symbol=symbols[i];
 const wait=1050-(Date.now()-lastRequestAt);
 if(lastRequestAt&&wait>0)await sleep(wait);
 lastRequestAt=Date.now();
 try{
  const j=await getJson("https://open-api.bingx.com/openApi/swap/v2/quote/openInterest?symbol="+encodeURIComponent(symbol));
  if(!(j.code===0||j.code==="0"))throw new Error("API code "+j.code);
  const value=Number(j.data?.openInterest);
  if(!Number.isFinite(value)||value<=0)throw new Error("missing/non-positive openInterest");
  results.push({symbol,ok:true});
 }catch(e){results.push({symbol,ok:false,error:String(e.message||e)});}
 if((i+1)%50===0)console.log(JSON.stringify({progress:i+1,total:symbols.length,passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length}));
}
const failed=results.filter(x=>!x.ok);
const report={generatedAt:new Date().toISOString(),catalog:{totalRows:catalog.data.length,activeUsdtCryptoCandidates:active.length,uniqueSymbols:symbols.length},openInterest:{requested:symbols.length,passed:results.length-failed.length,failed:failed.length,failedSymbols:failed},result:symbols.length>0&&failed.length===0?"PASS":"FAIL"};
await (await import("node:fs/promises")).writeFile("bingx-full-universe-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=="PASS")process.exitCode=1;

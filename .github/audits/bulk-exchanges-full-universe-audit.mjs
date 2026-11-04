const headers={accept:"application/json","user-agent":"Futures-scan-bulk-full-universe-audit/1.0"};
async function getJson(url){
 let last;
 for(let attempt=0;attempt<5;attempt++){
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(25000)});
   const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error("non-JSON HTTP "+r.status+": "+raw.slice(0,120))}
   if(r.status===429||r.status>=500){if(attempt===4)throw new Error("HTTP "+r.status);await new Promise(x=>setTimeout(x,1000*(attempt+1)));continue;}
   if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(j).slice(0,180));
   return j;
  }catch(e){last=e;if(attempt===4)break;await new Promise(x=>setTimeout(x,700*(attempt+1)));}
 }
 throw last??new Error("request failed");
}
const results={};
{
 const [contracts,tickers]=await Promise.all([
  getJson("https://api.mexc.com/api/v1/contract/detail"),
  getJson("https://api.mexc.com/api/v1/contract/ticker")
 ]);
 if(contracts.success!==true||!Array.isArray(contracts.data)||tickers.success!==true)throw new Error("MEXC contract/ticker schema invalid");
 const tickerRows=Array.isArray(tickers.data)?tickers.data:tickers.data?[tickers.data]:[];
 const bySymbol=new Map(tickerRows.map(x=>[x.symbol,x]));
 const active=contracts.data.filter(x=>Number(x.state)===0&&x.settleCoin==="USDT"&&Number(x.typeLabel)===0&&String(x.symbol??"").endsWith("_USDT"));
 const missing=active.filter(x=>{const v=Number(bySymbol.get(x.symbol)?.holdVol);return !Number.isFinite(v)||v<=0;}).map(x=>x.symbol);
 results.MEXC={contractRows:contracts.data.length,tickerRows:tickerRows.length,activeCryptoUsdtPerpetuals:active.length,oiPassed:active.length-missing.length,oiFailed:missing.length,failedSymbols:missing};
}
{
 const [instruments,oi]=await Promise.all([
  getJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP"),
  getJson("https://www.okx.com/api/v5/public/open-interest?instType=SWAP")
 ]);
 if(String(instruments.code)!=="0"||!Array.isArray(instruments.data)||String(oi.code)!=="0"||!Array.isArray(oi.data))throw new Error("OKX instruments/open-interest schema invalid");
 const active=instruments.data.filter(x=>String(x.instCategory)==="1"&&String(x.instId??"").toUpperCase().endsWith("-USDT-SWAP")&&x.state==="live");
 const byId=new Map(oi.data.map(x=>[x.instId,x]));
 const missing=active.filter(x=>{const v=Number(byId.get(x.instId)?.oi);return !Number.isFinite(v)||v<=0;}).map(x=>x.instId);
 results.OKX={swapInstrumentRows:instruments.data.length,openInterestRows:oi.data.length,activeCryptoUsdtPerpetuals:active.length,oiPassed:active.length-missing.length,oiFailed:missing.length,failedSymbols:missing};
}
{
 const j=await getJson("https://api-futures.kucoin.com/api/v1/contracts/active");
 if(String(j.code)!=="200000"||!Array.isArray(j.data))throw new Error("KuCoin active-contract catalog schema invalid");
 const active=j.data.filter(x=>{
  const categories=[x.marketType,x.assetClass].filter(v=>v!==null&&v!==undefined&&String(v).trim()!=="").map(v=>String(v).toUpperCase());
  return categories.length>0&&categories.every(v=>v==="CRYPTO")&&String(x.quoteCurrency??"").toUpperCase()==="USDT"&&String(x.settleCurrency??"").toUpperCase()==="USDT"&&String(x.symbol??"").toUpperCase().endsWith("USDTM");
 });
 const missing=active.filter(x=>{const v=Number(x.openInterest);return !Number.isFinite(v)||v<=0;}).map(x=>x.symbol);
 results.KuCoin={activeContractRows:j.data.length,activeCryptoUsdtPerpetuals:active.length,oiPassed:active.length-missing.length,oiFailed:missing.length,failedSymbols:missing};
}
const total=Object.values(results).reduce((s,x)=>s+x.activeCryptoUsdtPerpetuals,0);
const passed=Object.values(results).reduce((s,x)=>s+x.oiPassed,0);
const failed=Object.values(results).reduce((s,x)=>s+x.oiFailed,0);
const report={generatedAt:new Date().toISOString(),exchanges:results,summary:{activeCryptoUsdtPerpetuals:total,oiPassed:passed,oiFailed:failed},result:failed===0&&total>0?"PASS":"FAIL"};
await (await import("node:fs/promises")).writeFile("bulk-exchanges-full-universe-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=="PASS")process.exitCode=1;

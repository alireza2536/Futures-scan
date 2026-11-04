const url="https://api.hbdm.com/linear-swap-api/v1/swap_contract_info";
const r=await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan-HTX-label-audit/1.0"},signal:AbortSignal.timeout(20000)});
const j=await r.json();
if(!r.ok||j.status!=="ok"||!Array.isArray(j.data)) throw new Error("HTX contract API failed");
const active=j.data.filter(x=>Number(x.contract_status)===1&&String(x.contract_code??"").toUpperCase().endsWith("-USDT")&&String(x.trade_partition??"USDT").toUpperCase()==="USDT");
const labelArray=active.filter(x=>Array.isArray(x.tradfi_labels));
const tradfi=active.filter(x=>Array.isArray(x.tradfi_labels)&&x.tradfi_labels.length>0);
const tradfiTag=active.filter(x=>(x.labels??[]).map(v=>String(v).toLowerCase()).includes("tradfi"));
const unknown=active.filter(x=>!Array.isArray(x.tradfi_labels));
const result={
 generatedAt:new Date().toISOString(),
 totalContractRows:j.data.length,
 activeUsdt:active.length,
 tradfiLabelsFieldPresent:labelArray.length,
 tradfiLabelsNonEmpty:tradfi.length,
 tradfiTagCount:tradfiTag.length,
 unclassified:unknown.length,
 cryptoCandidates:active.filter(x=>Array.isArray(x.tradfi_labels)&&x.tradfi_labels.length===0).length,
 excluded:tradfi.map(x=>({symbol:x.symbol,contract_code:x.contract_code,labels:x.labels,tradfi_labels:x.tradfi_labels})),
 unknown:unknown.map(x=>({symbol:x.symbol,contract_code:x.contract_code,keys:Object.keys(x)}))
};
await (await import("node:fs/promises")).writeFile("htx-official-label-audit.json",JSON.stringify(result,null,2));
console.log(JSON.stringify({generatedAt:result.generatedAt,totalContractRows:result.totalContractRows,activeUsdt:result.activeUsdt,tradfiLabelsFieldPresent:result.tradfiLabelsFieldPresent,tradfiLabelsNonEmpty:result.tradfiLabelsNonEmpty,tradfiTagCount:result.tradfiTagCount,unclassified:result.unclassified,cryptoCandidates:result.cryptoCandidates,excluded:result.excluded.slice(0,30),unknown:result.unknown},null,2));

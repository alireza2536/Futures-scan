const headers={accept:"application/json","user-agent":"Futures-scan-HTX-full-universe-audit/1.0"};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJson(url){
 let last;
 for(let attempt=0;attempt<5;attempt++){
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
   const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error("non-JSON HTTP "+r.status+": "+raw.slice(0,140))}
   if(r.status===429||r.status>=500){if(attempt===4)throw new Error("HTTP "+r.status);await sleep(1000*(attempt+1));continue;}
   if(!r.ok)throw new Error("HTTP "+r.status+": "+JSON.stringify(j).slice(0,180));
   return j;
  }catch(e){last=e;if(attempt===4)break;await sleep(800*(attempt+1));}
 }
 throw last??new Error("HTX request failed");
}
async function mapLimit(items,limit,fn){
 const out=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(true){const i=next++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch(e){out[i]={contract_code:items[i],ok:false,error:String(e.message||e)}}}
 }));
 return out;
}
const payload=await getJson("https://api.hbdm.com/linear-swap-api/v1/swap_contract_info");
if(payload.status!=="ok"||!Array.isArray(payload.data))throw new Error("HTX contract catalog schema invalid");
const active=payload.data.filter(row=>Number(row.contract_status)===1&&String(row.contract_code??"").toUpperCase().endsWith("-USDT")&&String(row.trade_partition??"USDT").toUpperCase()==="USDT");
const hasTradfiLabel=row=>{
 const values=[...(Array.isArray(row.labels)?row.labels:[]),...(Array.isArray(row.tradfi_labels)?row.tradfi_labels:[])].map(v=>String(v??"").trim().toLowerCase().replace(/[\\s_-]+/g,""));
 return values.some(v=>/^(tradfi|traditionalfinance|stock|stocks|equity|equities|forex|fx|commodity|commodities|index|indices|metal|metals|energy|etf|preipo)$/.test(v));
};
const missingLabels=active.filter(row=>!Array.isArray(row.tradfi_labels));
if(missingLabels.length)throw new Error("HTX missing official tradfi_labels on "+missingLabels.length+" active USDT contracts");
const tradfi=active.filter(hasTradfiLabel);
const crypto=active.filter(row=>!hasTradfiLabel(row));
const results=await mapLimit(crypto.map(row=>row.contract_code),8,async contract_code=>{
 const url="https://api.hbdm.com/linear-swap-api/v1/swap_open_interest?contract_code="+encodeURIComponent(contract_code);
 const j=await getJson(url);
 if(j.status!=="ok")throw new Error("API status "+j.status);
 const rows=Array.isArray(j.data)?j.data:j.data?[j.data]:[];
 const row=rows.find(x=>x?.contract_code===contract_code)??rows[0];
 const value=Number(row?.volume??row?.amount??row?.open_interest);
 if(!Number.isFinite(value)||value<=0)throw new Error("missing/non-positive OI; keys="+Object.keys(row??{}).join(","));
 return {contract_code,ok:true,openInterest:value};
});
const passed=results.filter(x=>x?.ok).length;
const failed=results.filter(x=>!x?.ok);
const report={generatedAt:new Date().toISOString(),catalog:{totalRows:payload.data.length,activeUsdt:active.length,officialClassificationRows:active.length-missingLabels.length,tradfiExcluded:tradfi.length,cryptoCandidates:crypto.length,missingOfficialLabels:missingLabels.length},openInterest:{requested:crypto.length,passed,failed:failed.length,failedContracts:failed},result:crypto.length>0&&passed===crypto.length?"PASS":"FAIL"};
await (await import("node:fs/promises")).writeFile("htx-full-universe-audit.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.result!=="PASS")process.exitCode=1;

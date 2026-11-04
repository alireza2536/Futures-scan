const headers={accept:"application/json","user-agent":"Futures-scan-HTX-classification-audit/1.0"};
async function get(url){
 const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
 const raw=await r.text(); let j; try{j=JSON.parse(raw)}catch{throw new Error("non-json "+r.status+" "+raw.slice(0,150))}
 return {status:r.status,body:j};
}
const base="https://api.hbdm.com/linear-swap-api/v1/swap_contract_info";
const variants=[
 ["default",base],
 ["all_usdt",base+"?business_type=all&trade_partition=USDT"],
 ["all_all",base+"?business_type=all&trade_partition=ALL"],
 ["swap_usdt",base+"?business_type=swap&trade_partition=USDT"],
 ["futures_usdt",base+"?business_type=futures&trade_partition=USDT"],
 ["usdt_only",base+"?trade_partition=USDT"],
 ["contract_bot",base+"?contract_code=BOT-USDT"],
 ["contract_btc",base+"?contract_code=BTC-USDT"]
];
const results=[];
for(const [name,url] of variants){
 try{
  const {status,body}=await get(url);
  const rows=Array.isArray(body?.data)?body.data:[];
  const pick=code=>rows.find(x=>String(x.contract_code).toUpperCase()===code);
  results.push({name,httpStatus:status,apiStatus:body?.status,count:rows.length,keys:rows[0]?Object.keys(rows[0]):[],samples:["BTC-USDT","BOT-USDT","XAU-USDT","META-USDT","PAXG-USDT"].map(code=>pick(code)).filter(Boolean)});
 }catch(e){results.push({name,error:String(e.message||e)})}
}
const currencies=[];
for(const url of ["https://api.huobi.pro/v1/common/currencys","https://api.huobi.pro/v2/reference/currencies"]){
 try{const {status,body}=await get(url); currencies.push({url,httpStatus:status,apiStatus:body?.status,count:Array.isArray(body?.data)?body.data.length:null,contains: ["btc","bot","xau","meta","paxg"].map(x=>({currency:x,found:JSON.stringify(body?.data??[]).toLowerCase().includes('"'+x+'"')})),sample:(body?.data??[]).slice(0,5)});}
 catch(e){currencies.push({url,error:String(e.message||e)})}
}
const out={generatedAt:new Date().toISOString(),results,currencies};
await (await import("node:fs/promises")).writeFile("htx-classification-variants.json",JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));

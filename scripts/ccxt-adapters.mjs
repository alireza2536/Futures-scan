import ccxt from "ccxt";
import { TIMEFRAMES, aggregateHourlyTo2h, aggregateHourlyTo1d } from "./market-data.mjs";

const EXCHANGE_IDS = Object.freeze({
  BINGX: "bingx", WEEX: "weex", HTX: "htx", KUCOIN: "kucoinfutures", XT: "xt"
});
const TF = Object.freeze({ "5m":"5m", "15m":"15m", "1h":"1h", "2h":"2h", "4h":"4h", "1d":"1d" });
export function supportedCcxtExchanges() { return Object.keys(EXCHANGE_IDS); }

async function jsonRequest(url, timeoutMs=25000) {
  let lastError;
  for(let attempt=0;attempt<5;attempt+=1){
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan/0.7"},signal:controller.signal});
      const body=await response.json();
      if(!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0,180)}`);
      return body;
    }catch(error){
      lastError=error;
      if(attempt===4) break;
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)**2));
    }finally{clearTimeout(timer);}
  }
  throw lastError??new Error("Public market-data request failed");
}
function normalizeBar(timestamp,open,high,low,close,volume){
  const t=Number(timestamp);
  return {timestamp:t<1e12?t*1000:t,open:Number(open),high:Number(high),low:Number(low),close:Number(close),volume:Number(volume),confirmed:null};
}
function dedupeSort(rows){
  const map=new Map();
  for(const b of rows){
    if(![b.timestamp,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)) continue;
    if(b.volume<0||b.high<b.low||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)) continue;
    map.set(b.timestamp,b);
  }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
async function fetchBingxHistory(symbol,timeframe,count){
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const pair=symbol.includes("/")?symbol.split("/")[0]+"-"+symbol.split("/")[1].split(":")[0]:symbol;
  const params=new URLSearchParams({
    symbol:pair,interval:timeframe,
    startTime:String(Date.now()-intervalMs*(count+4)),
    endTime:String(Date.now()),
    limit:String(Math.min(1440,count+4)),timeZone:"0"
  });
  const payload=await jsonRequest("https://open-api.bingx.com/openApi/swap/v3/quote/klines?"+params);
  if(![0,"0"].includes(payload.code)||!Array.isArray(payload.data)){
    throw new Error("BingX kline rejected: "+payload.code+" "+(payload.msg??""));
  }
  const bars=dedupeSort(payload.data.map(row=>normalizeBar(row[0],row[1],row[2],row[3],row[4],row[5])));
  if(bars.length<count) throw new Error("BingX "+timeframe+": received "+bars.length+"/"+count+" valid candles");
  return bars.slice(-count);
}

async function fetchWeexHistory(symbol,timeframe,count){
  if(timeframe==="2h"){
    const hourly=await fetchWeexHistory(symbol,"1h",count*2+4);
    const bars=aggregateHourlyTo2h(hourly);
    if(bars.length<count) throw new Error(`WEEX 2h aggregation: ${bars.length}/${count}`);
    return bars.slice(-count);
  }
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const interval=timeframe;
  const collected=new Map();
  let cursor=Math.floor((Date.now()-intervalMs*(count+4))/intervalMs)*intervalMs;
  for(let page=0;page<Math.ceil(count/80)+40&&collected.size<count;page+=1){
    const end=Math.min(Date.now(),cursor+intervalMs*89);
    const params=new URLSearchParams({symbol:symbol.replace("/","").replace(":USDT",""),interval,startTime:String(cursor),endTime:String(end),limit:"100",priceType:"LAST"});
    const rows=await jsonRequest(`https://api-contract.weex.com/capi/v3/market/historyKlines?${params}`);
    if(!Array.isArray(rows)) throw new Error("WEEX historyKlines returned a non-array payload");
    const bars=rows.map(r=>normalizeBar(r[0],r[1],r[2],r[3],r[4],r[5]));
    if(!bars.length) break;
    for(const b of bars) collected.set(b.timestamp,b);
    const newest=Math.max(...bars.map(b=>b.timestamp));
    const next=newest+intervalMs;
    if(next<=cursor) break;
    cursor=next;
  }
  const bars=dedupeSort([...collected.values()]);
  if(bars.length<count) throw new Error(`WEEX ${timeframe}: ${bars.length}/${count} valid candles`);
  return bars.slice(-count);
}
async function fetchHtxHistory(symbol,timeframe,count){
  if(timeframe==="1d"){
    const hourly=await fetchHtxHistory(symbol,"1h",count*24+72);
    const bars=aggregateHourlyTo1d(hourly);
    if(bars.length<count) throw new Error("HTX UTC 1d aggregation: "+bars.length+"/"+count+" complete daily candles from hourly history");
    return bars.slice(-count);
  }
  if(timeframe==="2h"){
    const hourly=await fetchHtxHistory(symbol,"1h",count*2+4);
    const bars=aggregateHourlyTo2h(hourly);
    if(bars.length<count) throw new Error(`HTX 2h aggregation: ${bars.length}/${count}`);
    return bars.slice(-count);
  }
  const period={"5m":"5min","15m":"15min","1h":"60min","4h":"4hour","1d":"1day"}[timeframe];
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const collected=new Map();
  let cursor=Math.floor((Date.now()-intervalMs*(count+4))/intervalMs)*intervalMs;
  for(let page=0;page<Math.ceil(count/1800)+3&&collected.size<count;page+=1){
    const chunk=Math.min(1800,count-collected.size+4);
    const end=cursor+intervalMs*(chunk-1);
    const params=new URLSearchParams({contract_code:symbol,period});
    if(count<=2000) params.set("size",String(count+2));
    else {params.set("from",String(Math.floor(cursor/1000)));params.set("to",String(Math.floor(end/1000)));}
    const payload=await jsonRequest(`https://api.hbdm.com/linear-swap-ex/market/history/kline?${params}`);
    if(payload.status!=="ok"||!Array.isArray(payload.data)) throw new Error(`HTX kline rejected: ${payload["err-msg"]??payload.status}`);
    const bars=dedupeSort(payload.data.map(x=>normalizeBar(x.id,x.open,x.high,x.low,x.close,x.vol)));
    if(!bars.length) break;
    for(const b of bars) collected.set(b.timestamp,b);
    const newest=Math.max(...bars.map(b=>b.timestamp));
    const next=newest+intervalMs;
    if(next<=cursor) break;
    cursor=next;
  }
  const bars=dedupeSort([...collected.values()]);
  if(bars.length<count) throw new Error(`HTX ${timeframe}: API returned ${bars.length}/${count} candles (historical range/availability)`);
  return bars.slice(-count);
}
async function fetchKucoinHistory(client,symbol,timeframe,count){
  const granularity={"5m":5,"15m":15,"1h":60,"2h":120,"4h":240,"1d":1440}[timeframe];
  const market=client.market(symbol);
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const collected=new Map();
  let cursor=Math.floor((Date.now()-intervalMs*(count+4))/intervalMs)*intervalMs;
  for(let page=0;page<Math.ceil(count/450)+5&&collected.size<count;page+=1){
    const end=Math.min(Date.now(),cursor+intervalMs*499);
    const params=new URLSearchParams({symbol:market.id,granularity:String(granularity),from:String(cursor),to:String(end)});
    const payload=await jsonRequest(`https://api-futures.kucoin.com/api/v1/kline/query?${params}`);
    if(payload.code!=="200000"||!Array.isArray(payload.data)) throw new Error(`KuCoin kline rejected: ${payload.code}`);
    const bars=payload.data.map(r=>normalizeBar(r[0],r[1],r[2],r[3],r[4],r[5]));
    if(!bars.length) break;
    for(const b of bars) collected.set(b.timestamp,b);
    const newest=Math.max(...bars.map(b=>b.timestamp));
    const next=newest+intervalMs;
    if(next<=cursor) break;
    cursor=next;
  }
  const bars=dedupeSort([...collected.values()]);
  if(bars.length<count) throw new Error(`KuCoin ${timeframe}: ${bars.length}/${count} valid candles`);
  return bars.slice(-count);
}
async function fetchXtHistory(symbol,timeframe,count){
  if(timeframe==="2h"){
    const hourly=await fetchXtHistory(symbol,"1h",count*2+4);
    const bars=aggregateHourlyTo2h(hourly);
    if(bars.length<count) throw new Error(`XT 2h aggregation: ${bars.length}/${count}`);
    return bars.slice(-count);
  }
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const interval=timeframe;
  const collected=new Map();
  let cursor=Math.floor((Date.now()-intervalMs*(count+4))/intervalMs)*intervalMs;
  for(let page=0;page<5&&collected.size<count;page+=1){
    const end=Math.min(Date.now(),cursor+intervalMs*1499);
    const xtSymbol=symbol.includes("/")?symbol.split("/")[0]+"_"+symbol.split("/")[1].split(":")[0]:symbol;
    const params=new URLSearchParams({symbol:xtSymbol.toLowerCase(),interval,startTime:String(cursor),endTime:String(end),limit:"1500"});
    const payload=await jsonRequest(`https://fapi.xt.com/future/market/v1/public/q/kline?${params}`);
    if(payload.returnCode!==0||!Array.isArray(payload.result)) throw new Error(`XT kline rejected: ${payload.msgInfo??payload.returnCode}`);
    const bars=payload.result.map(x=>normalizeBar(x.t,x.o,x.h,x.l,x.c,x.a));
    if(!bars.length) break;
    for(const b of bars) collected.set(b.timestamp,b);
    const newest=Math.max(...bars.map(b=>b.timestamp));
    const next=newest+intervalMs;
    if(next<=cursor) break;
    cursor=next;
  }
  const bars=dedupeSort([...collected.values()]);
  if(bars.length<count) throw new Error(`XT ${timeframe}: ${bars.length}/${count} valid candles`);
  return bars.slice(-count);
}

export async function createCcxtAdapter(exchangeName) {
  const id=EXCHANGE_IDS[exchangeName];
  if(!id) throw new Error(`Unsupported CCXT adapter: ${exchangeName}`);
  const Exchange=ccxt[id];
  if(!Exchange) throw new Error(`Installed CCXT build does not provide ${id}`);
  const client=new Exchange({enableRateLimit:true,timeout:30000,options:{defaultType:"swap"}});
  if(exchangeName==="BINGX") client.rateLimit=Math.max(client.rateLimit??0,1300);
  try{
    await client.loadMarkets();
    const markets=Object.values(client.markets).filter(m=>
      m.active!==false&&m.swap===true&&m.linear===true&&m.quote==="USDT"&&m.settle==="USDT"&&m.base&&m.symbol
    );
    if(!markets.length) throw new Error(`${exchangeName}: no active linear USDT perpetual markets returned`);
    let tickers;
    try{tickers=await client.fetchTickers(markets.map(m=>m.symbol));}
    catch{tickers=await client.fetchTickers();}
    const symbols=markets.map(m=>({exchange:exchangeName,symbol:m.symbol,baseAsset:m.base,display:m.symbol,lastPriceUsd:Number(tickers?.[m.symbol]?.last)}));
    return {client,symbols};
  }catch(error){await client.close?.();throw error;}
}

export async function fetchCcxtHistory({client,symbol,timeframe,count=1203}){
  if(!TF[timeframe]) throw new Error(`Unsupported timeframe: ${timeframe}`);
  if(!Number.isInteger(count)||count<2||count>5000) throw new Error("count must be 2..5000");
  if(client.id==="bingx") return fetchBingxHistory(client.market(symbol).id,timeframe,count);
  if(client.id==="weex") return fetchWeexHistory(symbol,timeframe,count);
  if(client.id==="htx") return fetchHtxHistory(client.market(symbol).id,timeframe,count);
  if(client.id==="kucoinfutures") return fetchKucoinHistory(client,symbol,timeframe,count);
  if(client.id==="xt") return fetchXtHistory(client.market(symbol).id,timeframe,count);
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  const collected=new Map();
  let since=Math.floor((Date.now()-intervalMs*(count+8))/intervalMs)*intervalMs;
  let previousNewest=-1;
  for(let page=0;page<Math.ceil(count/500)+10&&collected.size<count;page+=1){
    const limit=Math.min(1000,count-collected.size+5);
    let rows,lastError;
    for(let attempt=0;attempt<5;attempt+=1){
      try{rows=await client.fetchOHLCV(symbol,TF[timeframe],since,limit);break;}
      catch(error){lastError=error;if(attempt===4)throw error;await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));}
    }
    if(!Array.isArray(rows)||!rows.length) break;
    let newest=-1;
    for(const row of rows){
      if(!Array.isArray(row)||row.length<6) continue;
      const bar=normalizeBar(row[0],row[1],row[2],row[3],row[4],row[5]);
      if(bar.timestamp%intervalMs===0&&bar.volume>=0&&bar.high>=bar.low&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)){
        collected.set(bar.timestamp,bar);newest=Math.max(newest,bar.timestamp);
      }
    }
    if(newest<0||newest<=previousNewest) break;
    previousNewest=newest;since=newest+intervalMs;
    if(rows.length<2) break;
  }
  const bars=dedupeSort([...collected.values()]);
  if(bars.length<count) throw new Error(`${symbol} ${timeframe}: received ${bars.length}/${count} valid aligned candles`);
  return bars.slice(-count);
}

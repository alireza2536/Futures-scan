import ccxt from "ccxt";
import { TIMEFRAMES } from "./market-data.mjs";

const EXCHANGE_IDS = Object.freeze({
  BINGX: "bingx",
  WEEX: "weex",
  HTX: "htx",
  KUCOIN: "kucoinfutures",
  XT: "xt"
});
const TF = Object.freeze({
  "5m":"5m", "15m":"15m", "1h":"1h", "2h":"2h", "4h":"4h", "1d":"1d"
});

export function supportedCcxtExchanges() { return Object.keys(EXCHANGE_IDS); }

export async function createCcxtAdapter(exchangeName) {
  const id=EXCHANGE_IDS[exchangeName];
  if(!id) throw new Error(`Unsupported CCXT adapter: ${exchangeName}`);
  const Exchange=ccxt[id];
  if(!Exchange) throw new Error(`Installed CCXT build does not provide ${id}`);
  const client=new Exchange({enableRateLimit:true,timeout:25000,options:{defaultType:"swap"}});
  await client.loadMarkets();
  const markets=Object.values(client.markets).filter(m=>
    m.active!==false && m.swap===true && m.linear===true &&
    m.quote==="USDT" && m.settle==="USDT" && m.base && m.symbol
  );
  if(!markets.length) throw new Error(`${exchangeName}: no active linear USDT perpetual markets returned`);
  const tickers=await client.fetchTickers(markets.map(m=>m.symbol));
  const symbols=markets.map(m=>({
    exchange:exchangeName,
    symbol:m.symbol,
    baseAsset:m.base,
    display:m.symbol,
    lastPriceUsd:Number(tickers?.[m.symbol]?.last)
  }));
  return {client,symbols};
}

export async function fetchCcxtHistory({client,symbol,timeframe,count=1203}) {
  if(!TF[timeframe]) throw new Error(`Unsupported timeframe: ${timeframe}`);
  if(!Number.isInteger(count)||count<2||count>2000) throw new Error("count must be 2..2000");
  const intervalMs=TIMEFRAMES[timeframe].seconds*1000;
  let since=Date.now()-intervalMs*(count+5);
  const collected=new Map();
  let stagnant=0;
  for(let page=0;page<Math.ceil(count/100)+8 && collected.size<count;page+=1){
    const rows=await client.fetchOHLCV(symbol,TF[timeframe],since,Math.min(200,count-collected.size+5));
    if(!Array.isArray(rows)||!rows.length) break;
    let newest=since;
    for(const row of rows){
      if(!Array.isArray(row)||row.length<6) continue;
      const bar={timestamp:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]),confirmed:null};
      if([bar.timestamp,bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)) collected.set(bar.timestamp,bar);
      newest=Math.max(newest,bar.timestamp);
    }
    const next=newest+intervalMs;
    if(next<=since){stagnant+=1;if(stagnant>=2)break;} else {since=next;stagnant=0;}
    if(rows.length<2) break;
  }
  const bars=[...collected.values()].sort((a,b)=>a.timestamp-b.timestamp);
  if(bars.length<count) throw new Error(`${symbol} ${timeframe}: received ${bars.length}/${count} candles`);
  return bars.slice(-count);
}

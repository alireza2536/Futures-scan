import ccxt from "ccxt";

const exchange = new ccxt.htx({ enableRateLimit: true, timeout: 25000, options: { defaultType: "swap" } });
const targets = [{tf:"15m",ms:900000},{tf:"4h",ms:14400000}];
try {
  await exchange.loadMarkets();
  const market = Object.values(exchange.markets).find(m => m?.active !== false && m.contract && m.swap && m.base === "BTC" && m.quote === "USDT" && m.settle === "USDT");
  if (!market) throw new Error("No active BTC USDT perpetual in CCXT markets");
  console.log("MARKET", JSON.stringify({symbol:market.symbol,id:market.id,api:exchange.urls.api}));
  for (const t of targets) {
    console.log("TIMEFRAME",t.tf);
    let since = Date.now() - t.ms * 2000;
    const all = new Map();
    for (let page=0;page<4;page++) {
      const rows = await exchange.fetchOHLCV(market.symbol,t.tf,since,1000);
      const valid = (rows||[]).filter(r=>Array.isArray(r)&&r.length>=6&&Number.isFinite(Number(r[0])));
      for (const r of valid) all.set(Number(r[0]),r);
      const newest = valid.length ? Math.max(...valid.map(r=>Number(r[0]))) : NaN;
      const oldest = valid.length ? Math.min(...valid.map(r=>Number(r[0]))) : NaN;
      console.log("CCXT_PAGE",JSON.stringify({tf:t.tf,page,since:new Date(since).toISOString(),count:valid.length,oldest:Number.isFinite(oldest)?new Date(oldest).toISOString():null,newest:Number.isFinite(newest)?new Date(newest).toISOString():null,totalUnique:all.size}));
      if (!valid.length || !Number.isFinite(newest) || newest < since || valid.length < 2) break;
      const nextSince = newest + t.ms;
      if (nextSince <= since || nextSince >= Date.now()) break;
      since = nextSince;
    }
    console.log("CCXT_SUMMARY",JSON.stringify({tf:t.tf,totalUnique:all.size,pass:all.size>=1201}));
  }
  for (const t of targets) {
    const period = t.tf === "15m" ? "15min" : "4hour";
    const url = new URL("https://api.hbdm.com/linear-swap-ex/market/history/kline");
    url.search = new URLSearchParams({contract_code:"BTC-USDT",period,size:"2000"}).toString();
    const response = await fetch(url,{headers:{accept:"application/json","user-agent":"Futures-scan/0.3"}});
    const body = await response.json();
    const rows = Array.isArray(body.data) ? body.data : [];
    console.log("DIRECT_SUMMARY",JSON.stringify({tf:t.tf,http:response.status,status:body.status,count:rows.length,oldest:rows.length?new Date(Number(rows.at(-1).id)*1000).toISOString():null,latest:rows.length?new Date(Number(rows[0].id)*1000).toISOString():null}));
  }
} finally { try { await exchange.close(); } catch {} }

import { fetchOkxHistory, fetchMexcHistory, assertCandleCoverage } from "./market-data.mjs";
import { calculateLatestIndicators } from "./indicators.mjs";

const REQUIRED_CLOSED_CANDLES=1201;
const TIMEFRAME="5m";
const INTERVAL_MS=300000;

function onlyClosedFiveMinuteCandles(bars,now=Date.now()) {
  return bars.filter(bar=>bar.confirmed===false?false:
    bar.confirmed===true?true:
    Number.isFinite(bar.timestamp)&&bar.timestamp+INTERVAL_MS<=now);
}

async function verify(name,fetcher) {
  try {
    // Two extra bars provide room to discard the still-forming candle(s).
    const raw=await fetcher(REQUIRED_CLOSED_CANDLES+2);
    const closed=onlyClosedFiveMinuteCandles(raw).slice(-REQUIRED_CLOSED_CANDLES);
    const bars=assertCandleCoverage(closed,TIMEFRAME,REQUIRED_CLOSED_CANDLES);
    const indicators=calculateLatestIndicators(bars,{cciLength:1000});
    for(const key of ["ema9","ema20","ema21","ema50","cci","vwap"]) {
      if(!Number.isFinite(indicators[key])) throw new Error(`non-finite ${key} result`);
    }
    return {
      exchange:name,status:"PASS",timeframe:TIMEFRAME,
      closedCandles:bars.length,
      firstCandleAt:new Date(bars[0].timestamp).toISOString(),
      lastClosedCandleAt:new Date(bars.at(-1).timestamp).toISOString(),
      latestClose:indicators.close,
      ema9:indicators.ema9,ema20:indicators.ema20,ema21:indicators.ema21,ema50:indicators.ema50,
      cci1000:indicators.cci,vwap:indicators.vwap
    };
  } catch(error) {
    return {exchange:name,status:"FAIL",timeframe:TIMEFRAME,error:error.message};
  }
}

const results=await Promise.all([
  verify("OKX",count=>fetchOkxHistory({
    base:process.env.OKX_BASE_URL??"https://openapi.okx.com",
    instId:"BTC-USDT-SWAP",bar:"5m",count
  })),
  verify("MEXC",count=>fetchMexcHistory({
    base:process.env.MEXC_BASE_URL??"https://api.mexc.com",
    symbol:"BTC_USDT",interval:"5m",count
  }))
]);
console.log(JSON.stringify({
  test:"5m-live-history-and-indicator-coverage",
  requiredClosedCandles:REQUIRED_CLOSED_CANDLES,
  generatedAt:new Date().toISOString(),
  results
},null,2));
if(results.some(result=>result.status!=="PASS")) process.exitCode=1;

export const DAILY_CCI_LENGTH = 1000;
export const DAILY_RAW_RETENTION = 90;
export const DAILY_EMA_LENGTH = 500;

export function typicalPrice(bar) {
  const values=[bar?.timestamp,bar?.high,bar?.low,bar?.close];
  if(!values.every(Number.isFinite)||bar.high<bar.low) throw new Error("Invalid daily candle for CCI state");
  return (bar.high+bar.low+bar.close)/3;
}

export function calculateCCIFromTypicalPrices(values,length=DAILY_CCI_LENGTH) {
  if(!Number.isInteger(length)||length<1||!Array.isArray(values)||values.length<length||
     values.some(value=>!Number.isFinite(value))) throw new Error(`CCI(${length}) requires at least ${length} finite typical prices`);
  const window=values.slice(-length);
  const mean=window.reduce((sum,value)=>sum+value,0)/length;
  const meanDeviation=window.reduce((sum,value)=>sum+Math.abs(value-mean),0)/length;
  return meanDeviation===0?0:(window[length-1]-mean)/(0.015*meanDeviation);
}

// Keep a rolling 1000-point CCI input window, EMA500 state, and only 90 raw OHLCV candles.
export function advanceDailyCCIState(previous,bars) {
  if(!Array.isArray(bars)||!bars.length) throw new Error("Daily candles are required");
  const points=new Map();
  for(const point of previous?.typicalPrices??[]) {
    if(!Number.isFinite(point.timestamp)||!Number.isFinite(point.value)) throw new Error("Invalid stored CCI point");
    points.set(point.timestamp,point.value);
  }
  const raw=new Map();
  for(const candle of previous?.recentCandles??[]) raw.set(candle.timestamp,candle);
  for(const candle of bars) {
    points.set(candle.timestamp,typicalPrice(candle));
    raw.set(candle.timestamp,candle);
  }
  const typicalPrices=[...points.entries()].sort((a,b)=>a[0]-b[0]).slice(-DAILY_CCI_LENGTH)
    .map(([timestamp,value])=>({timestamp,value}));
  const recentCandles=[...raw.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-DAILY_RAW_RETENTION);
  if(typicalPrices.length<DAILY_CCI_LENGTH) throw new Error(`Daily CCI history incomplete: ${typicalPrices.length}/${DAILY_CCI_LENGTH}`);
  const cci=calculateCCIFromTypicalPrices(typicalPrices.map(x=>x.value));

  // Seed EMA500 from the first available 500 closed daily candles, then
  // advance only with newer daily closes. Persisting this value avoids
  // needing to retain/re-download the full EMA history on every scan.
  let ema500=Number.isFinite(previous?.ema500)?previous.ema500:null;
  const orderedBars=[...bars].sort((a,b)=>a.timestamp-b.timestamp);
  const lastTimestamp=Number.isFinite(previous?.lastTimestamp)?previous.lastTimestamp:null;
  const newBars=lastTimestamp===null?orderedBars:orderedBars.filter(bar=>bar.timestamp>lastTimestamp);
  const hasGap=lastTimestamp!==null&&newBars.length>0&&newBars[0].timestamp!==lastTimestamp+86400000;
  if(ema500===null||hasGap||(lastTimestamp!==null&&lastTimestamp>orderedBars.at(-1).timestamp)){
    if(orderedBars.length<DAILY_EMA_LENGTH) throw new Error(`Daily EMA(${DAILY_EMA_LENGTH}) history incomplete: ${orderedBars.length}/${DAILY_EMA_LENGTH}`);
    const alpha=2/(DAILY_EMA_LENGTH+1);
    ema500=orderedBars[0].close;
    for(let i=1;i<orderedBars.length;i+=1) ema500=alpha*orderedBars[i].close+(1-alpha)*ema500;
  } else {
    const alpha=2/(DAILY_EMA_LENGTH+1);
    for(const bar of newBars) ema500=alpha*bar.close+(1-alpha)*ema500;
  }
  return {lastTimestamp:typicalPrices.at(-1).timestamp,typicalPrices,recentCandles,cci,ema500};
}

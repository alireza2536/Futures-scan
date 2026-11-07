export const DAILY_CCI_LENGTH = 1000;
export const DAILY_CCI_FETCH_COUNT = 1001;
export const DAILY_RAW_RETENTION = 90;
export const DAILY_EMA_LENGTH = 500;
const DAY_MS = 86400000;

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

function assertContiguousDaily(points,label,required=points.length) {
  if(points.length<required) throw new Error(`${label} history incomplete: ${points.length}/${required}`);
  const tail=points.slice(-required);
  for(let i=1;i<tail.length;i+=1) {
    if(tail[i].timestamp-tail[i-1].timestamp!==DAY_MS) throw new Error(`${label} history has a missing daily candle`);
  }
  return tail;
}

// 1001 fetched daily candles provide one extra closed candle for edge validation.
// Keep the exact 1000-point CCI input window, EMA500 plus its own timestamp,
// and no more than 90 raw OHLCV candles.
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
  const orderedPoints=[...points.entries()].sort((a,b)=>a[0]-b[0]).map(([timestamp,value])=>({timestamp,value}));
  const typicalPrices=assertContiguousDaily(orderedPoints,"Daily CCI",DAILY_CCI_LENGTH).slice(-DAILY_CCI_LENGTH);
  const recentCandles=[...raw.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-DAILY_RAW_RETENTION);
  const cci=calculateCCIFromTypicalPrices(typicalPrices.map(x=>x.value));

  let ema500=Number.isFinite(previous?.ema500)?previous.ema500:null;
  let ema500Timestamp=Number.isFinite(previous?.ema500Timestamp)?previous.ema500Timestamp:
    Number.isFinite(previous?.lastTimestamp)?previous.lastTimestamp:null;
  const orderedBars=[...new Map(bars.map(bar=>[bar.timestamp,bar])).values()].sort((a,b)=>a.timestamp-b.timestamp);
  const newBars=ema500Timestamp===null?orderedBars:orderedBars.filter(bar=>bar.timestamp>ema500Timestamp);
  const internalGap=newBars.some((bar,index)=>index>0&&bar.timestamp-newBars[index-1].timestamp!==DAY_MS);
  const leadingGap=ema500Timestamp!==null&&newBars.length>0&&newBars[0].timestamp-ema500Timestamp!==DAY_MS;
  const needsSeed=ema500===null||internalGap||leadingGap||
    (ema500Timestamp!==null&&orderedBars.at(-1).timestamp<ema500Timestamp);
  if(needsSeed) {
    const seedBars=assertContiguousDaily(orderedBars,"Daily EMA500",DAILY_EMA_LENGTH);
    const alpha=2/(DAILY_EMA_LENGTH+1);
    ema500=seedBars[0].close;
    for(let i=1;i<seedBars.length;i+=1) ema500=alpha*seedBars[i].close+(1-alpha)*ema500;
    ema500Timestamp=seedBars.at(-1).timestamp;
  } else {
    const alpha=2/(DAILY_EMA_LENGTH+1);
    for(const bar of newBars) {
      ema500=alpha*bar.close+(1-alpha)*ema500;
      ema500Timestamp=bar.timestamp;
    }
  }
  return {lastTimestamp:typicalPrices.at(-1).timestamp,typicalPrices,recentCandles,cci,ema500,ema500Timestamp};
}

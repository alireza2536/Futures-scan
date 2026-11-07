import test from "node:test";
import assert from "node:assert/strict";
import { calculateEMA, calculateCCI, calculateVWAP, calculateLatestIndicators } from "./indicators.mjs";

const mkBars=(n,baseTs=Date.UTC(2026,10,5))=>Array.from({length:n},(_,i)=>({
  timestamp:baseTs+i*60000,open:10+i,high:12+i,low:9+i,close:11+i,volume:100
}));

test("EMA uses first-value seed and recursive smoothing",()=>{
  assert.deepEqual(calculateEMA([1,2,3,4,5],3),[1,1.5,2.25,3.125,4.0625]);
});
test("CCI is zero for constant typical price",()=>{
  const bars=Array.from({length:5},(_,i)=>({timestamp:i+1,open:10,high:11,low:9,close:10,volume:1}));
  assert.deepEqual(calculateCCI(bars,3),[null,null,0,0,0]);
});
test("session VWAP is volume weighted within the UTC day",()=>{
  const bars=[
    {timestamp:Date.UTC(2026,10,5,0,0),open:1,high:2,low:0,close:1.5,volume:10},
    {timestamp:Date.UTC(2026,10,5,0,1),open:2,high:3,low:1,close:2.5,volume:10},
    {timestamp:Date.UTC(2026,10,6,0,0),open:4,high:5,low:3,close:4.5,volume:10}
  ];
  const v=calculateVWAP(bars);
  assert.ok(Math.abs(v[1]-((1.1666666666666667+2.1666666666666665)/2))<1e-12);
  assert.ok(Math.abs(v[2]-4.166666666666667)<1e-12);
});
test("zero-volume session produces null rather than NaN",()=>{
  const bars=mkBars(3).map(x=>({...x,volume:0}));
  assert.equal(calculateVWAP(bars).at(-1),null);
});
test("latest indicators expose EMA9, EMA21, EMA500, CCI1000 and VWAP",()=>{
  const bars=mkBars(1201);
  const v=calculateLatestIndicators(bars);
  for(const key of ["ema9","ema21","ema","cci","vwap"]) assert.ok(Number.isFinite(v[key]),key);
  assert.equal(v.candleCount,1201);
});
test("rejects duplicate timestamps and malformed OHLCV",()=>{
  const bars=mkBars(4);
  assert.throws(()=>calculateVWAP([...bars,{...bars[3]}]),/chronological and unique/);
  assert.throws(()=>calculateVWAP([{...bars[0],volume:-1}]),/Invalid OHLCV/);
});
test("requires enough history for CCI1000 and EMA500",()=>{
  assert.throws(()=>calculateLatestIndicators(mkBars(999)),/At least 1000/);
});

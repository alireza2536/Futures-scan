import test from "node:test";
import assert from "node:assert/strict";
import {advanceDailyCCIState,calculateCCIFromTypicalPrices,DAILY_CCI_LENGTH,DAILY_RAW_RETENTION} from "./daily-cci-state.mjs";

const bars=(n,start=Date.UTC(2020,0,1))=>Array.from({length:n},(_,i)=>({timestamp:start+i*86400000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10}));

test("daily CCI1000 initializes from 1000 daily typical prices",()=>{
  const state=advanceDailyCCIState(null,bars(1000));
  assert.equal(state.typicalPrices.length,1000);
  assert.equal(state.cci,calculateCCIFromTypicalPrices(bars(1000).map(x=>(x.high+x.low+x.close)/3)));
});
test("daily CCI state keeps 1000 compressed inputs and only 90 raw candles",()=>{
  const state=advanceDailyCCIState(null,bars(1200));
  assert.equal(state.typicalPrices.length,DAILY_CCI_LENGTH);
  assert.equal(state.recentCandles.length,DAILY_RAW_RETENTION);
});
test("incremental update matches a fresh full-window CCI1000 calculation",()=>{
  const first=bars(1000);
  const initial=advanceDailyCCIState(null,first);
  const next=bars(1001);
  const updated=advanceDailyCCIState(initial,next.slice(-2));
  const expected=calculateCCIFromTypicalPrices(next.slice(-1000).map(x=>(x.high+x.low+x.close)/3));
  assert.ok(Math.abs(updated.cci-expected)<1e-10);
  assert.equal(updated.lastTimestamp,next.at(-1).timestamp);
});

test("daily EMA500 initializes from daily candles and keeps only 90 raw candles",()=>{
  const state=advanceDailyCCIState(null,bars(1200));
  assert.ok(Number.isFinite(state.ema500));
  assert.equal(state.recentCandles.length,DAILY_RAW_RETENTION);
  const alpha=2/501;
  let expected=bars(1200)[0].close;
  for(const bar of bars(1200).slice(1)) expected=alpha*bar.close+(1-alpha)*expected;
  assert.ok(Math.abs(state.ema500-expected)<1e-10);
});
test("daily EMA500 advances incrementally without reseeding",()=>{
  const first=bars(1200);
  const initial=advanceDailyCCIState(null,first);
  const extended=bars(1201);
  const updated=advanceDailyCCIState(initial,extended.slice(-2));
  const alpha=2/501;
  const expected=alpha*extended.at(-1).close+(1-alpha)*initial.ema500;
  assert.ok(Math.abs(updated.ema500-expected)<1e-10);
});
test("daily EMA500 reseeds after a missing daily candle",()=>{
  const initial=advanceDailyCCIState(null,bars(1200));
  const gapBars=bars(1201,initial.lastTimestamp+2*86400000);
  const updated=advanceDailyCCIState(initial,gapBars);
  assert.ok(Number.isFinite(updated.ema500));
});
test("rejects fewer than 1000 values",()=>assert.throws(()=>calculateCCIFromTypicalPrices([1,2,3]),/requires at least/));

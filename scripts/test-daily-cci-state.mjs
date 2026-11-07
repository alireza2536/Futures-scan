import test from "node:test";
import assert from "node:assert/strict";
import {advanceDailyCCIState,calculateCCIFromTypicalPrices,DAILY_CCI_LENGTH,DAILY_CCI_FETCH_COUNT,DAILY_RAW_RETENTION} from "./daily-cci-state.mjs";

const bars=(n,start=Date.UTC(2020,0,1))=>Array.from({length:n},(_,i)=>({timestamp:start+i*86400000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10}));

test("1001 closed daily candles initialize CCI1000 and retain exactly 1000 Typical Prices",()=>{
  const input=bars(DAILY_CCI_FETCH_COUNT);
  const state=advanceDailyCCIState(null,input);
  assert.equal(input.length,1001);
  assert.equal(state.typicalPrices.length,DAILY_CCI_LENGTH);
  assert.equal(state.typicalPrices[0].timestamp,input[1].timestamp);
  assert.equal(state.cci,calculateCCIFromTypicalPrices(input.slice(-1000).map(x=>(x.high+x.low+x.close)/3)));
});
test("daily CCI state keeps 1000 compressed inputs and only 90 raw candles",()=>{
  const state=advanceDailyCCIState(null,bars(1200));
  assert.equal(state.typicalPrices.length,DAILY_CCI_LENGTH);
  assert.equal(state.recentCandles.length,DAILY_RAW_RETENTION);
});
test("incremental update matches a fresh full-window CCI1000 calculation",()=>{
  const first=bars(DAILY_CCI_FETCH_COUNT);
  const initial=advanceDailyCCIState(null,first);
  const next=bars(1002);
  const updated=advanceDailyCCIState(initial,next.slice(-2));
  const expected=calculateCCIFromTypicalPrices(next.slice(-1000).map(x=>(x.high+x.low+x.close)/3));
  assert.ok(Math.abs(updated.cci-expected)<1e-10);
  assert.equal(updated.lastTimestamp,next.at(-1).timestamp);
  assert.equal(updated.typicalPrices.length,1000);
});
test("rejects a missing candle inside the latest CCI1000 input window",()=>{
  const input=bars(1002);
  input[500].timestamp+=3600000;
  assert.throws(()=>advanceDailyCCIState(null,input),/missing daily candle/);
});
test("rejects fewer than 1000 values",()=>assert.throws(()=>calculateCCIFromTypicalPrices([1,2,3]),/requires at least/));

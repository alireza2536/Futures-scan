import test from "node:test";
import assert from "node:assert/strict";
import { TIMEFRAMES, assertCandleCoverage } from "./market-data.mjs";

test("the five supported intraday timeframes are defined for both active adapters",()=>{
  assert.deepEqual(Object.keys(TIMEFRAMES),["5m","15m","1h","2h","4h"]);
  for(const tf of Object.values(TIMEFRAMES)) {
    assert.ok(tf.okx);
    assert.ok(tf.mexc);
    assert.ok(Number.isInteger(tf.seconds)&&tf.seconds>0);
  }
});
test("timeframe durations and the exact 5m exchange mappings are correct",()=>{
  assert.deepEqual(TIMEFRAMES["5m"],{okx:"5m",mexc:"Min5",seconds:300});
  assert.equal(TIMEFRAMES["15m"].seconds,900);
  assert.equal(TIMEFRAMES["1h"].seconds,3600);
  assert.equal(TIMEFRAMES["2h"].seconds,7200);
  assert.equal(TIMEFRAMES["4h"].seconds,14400);
  assert.equal(TIMEFRAMES["1d"],undefined);
});
const makeFiveMinuteBars=(count=1001)=>Array.from({length:count},(_,i)=>({
  timestamp:Date.UTC(2026,0,1)+i*300000,
  open:100,high:102,low:99,close:101,volume:10,confirmed:true
}));
test("5m coverage accepts exactly 1001 closed consecutive aligned candles",()=>{
  const bars=makeFiveMinuteBars();
  assert.equal(assertCandleCoverage(bars,"5m",1001).length,1001);
});
test("5m coverage rejects insufficient candle history",()=>{
  assert.throws(()=>assertCandleCoverage(makeFiveMinuteBars(1000),"5m",1001),/1000\/1001/);
});
test("5m coverage rejects missing intervals instead of silently calculating indicators",()=>{
  const bars=makeFiveMinuteBars();
  bars[500].timestamp+=300000;
  assert.throws(()=>assertCandleCoverage(bars,"5m",1001),/gap\/overlap/);
});
test("5m coverage rejects unclosed candles",()=>{
  const bars=makeFiveMinuteBars();
  bars[1000].confirmed=false;
  assert.throws(()=>assertCandleCoverage(bars,"5m",1001),/unclosed candle/);
});
test("5m coverage rejects misaligned candle timestamps",()=>{
  const bars=makeFiveMinuteBars();
  bars[10].timestamp+=1000;
  assert.throws(()=>assertCandleCoverage(bars,"5m",1001),/not interval-aligned/);
});

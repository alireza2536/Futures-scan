import test from "node:test";
import assert from "node:assert/strict";
import { TIMEFRAMES } from "./market-data.mjs";

test("all six requested timeframes are defined for both active adapters",()=>{
  assert.deepEqual(Object.keys(TIMEFRAMES),["5m","15m","1h","2h","4h","1d"]);
  for(const tf of Object.values(TIMEFRAMES)) {
    assert.ok(tf.okx);
    assert.ok(tf.mexc);
    assert.ok(Number.isInteger(tf.seconds)&&tf.seconds>0);
  }
});
test("timeframe durations are exact",()=>{
  assert.equal(TIMEFRAMES["5m"].seconds,300);
  assert.equal(TIMEFRAMES["15m"].seconds,900);
  assert.equal(TIMEFRAMES["1h"].seconds,3600);
  assert.equal(TIMEFRAMES["2h"].seconds,7200);
  assert.equal(TIMEFRAMES["4h"].seconds,14400);
  assert.equal(TIMEFRAMES["1d"].seconds,86400);
});

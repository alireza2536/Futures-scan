function assertBars(bars, length) {
  if (!Array.isArray(bars) || bars.length < length) {
    throw new Error(`At least ${length} candles are required`);
  }
  for (const bar of bars) {
    if (![bar.high, bar.low, bar.close].every(Number.isFinite) || bar.high < bar.low) {
      throw new Error("Invalid OHLC candle data");
    }
  }
}

export function calculateEMA(values, length) {
  if (!Number.isInteger(length) || length < 1) throw new Error("EMA length must be a positive integer");
  if (!Array.isArray(values) || values.length < length || values.some(value => !Number.isFinite(value))) {
    throw new Error(`EMA(${length}) requires at least ${length} finite values`);
  }
  const output = Array(values.length).fill(null);
  const alpha = 2 / (length + 1);
  // Match TradingView Pine ta.ema(): seed from the first valid source value,
  // then apply alpha * source + (1 - alpha) * previous EMA on every bar.
  let previous = values[0];
  output[0] = previous;
  for (let i = 1; i < values.length; i += 1) {
    previous = alpha * values[i] + (1 - alpha) * previous;
    output[i] = previous;
  }
  return output;
}

export function calculateCCI(bars, length) {
  if (!Number.isInteger(length) || length < 1) throw new Error("CCI length must be a positive integer");
  assertBars(bars, length);
  const typical = bars.map(bar => (bar.high + bar.low + bar.close) / 3);
  const output = Array(bars.length).fill(null);
  for (let i = length - 1; i < typical.length; i += 1) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j += 1) sum += typical[j];
    const mean = sum / length;
    let deviation = 0;
    for (let j = i - length + 1; j <= i; j += 1) deviation += Math.abs(typical[j] - mean);
    const meanDeviation = deviation / length;
    output[i] = meanDeviation === 0 ? 0 : (typical[i] - mean) / (0.015 * meanDeviation);
  }
  return output;
}

export function calculateLatestIndicators(bars, { emaLength = 500, cciLength = 1200 } = {}) {
  assertBars(bars, Math.max(emaLength, cciLength));
  const closes = bars.map(bar => bar.close);
  const ema = calculateEMA(closes, emaLength);
  const cci = calculateCCI(bars, cciLength);
  const last = bars.length - 1;
  return {
    timestamp: bars[last].timestamp,
    close: closes[last],
    ema: ema[last],
    cci: cci[last],
    candleCount: bars.length
  };
}

function assertBars(bars, length) {
  if (!Array.isArray(bars) || bars.length < length) throw new Error(`At least ${length} candles are required`);
  for (const bar of bars) {
    if (![bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.high < bar.low || bar.volume < 0 ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
      throw new Error("Invalid OHLCV candle data");
    }
  }
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].timestamp <= bars[i - 1].timestamp) throw new Error("Candles must be strictly chronological and unique");
  }
}

export function calculateEMA(values, length) {
  if (!Number.isInteger(length) || length < 1) throw new Error("EMA length must be a positive integer");
  if (!Array.isArray(values) || values.length < length || values.some(value => !Number.isFinite(value))) {
    throw new Error(`EMA(${length}) requires at least ${length} finite values`);
  }
  const output = Array(values.length).fill(null);
  const alpha = 2 / (length + 1);
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

// TradingView-style rolling VWAP: sum(typical price * volume) / sum(volume)
// over the supplied candle window. This is not session-reset VWAP.
export function calculateVWAP(bars, length = bars?.length) {
  if (!Number.isInteger(length) || length < 1) throw new Error("VWAP length must be a positive integer");
  assertBars(bars, length);
  const output = Array(bars.length).fill(null);
  let pv = 0;
  let volume = 0;
  const queue = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const typical = (bar.high + bar.low + bar.close) / 3;
    const weighted = typical * bar.volume;
    queue.push({ weighted, volume: bar.volume });
    pv += weighted;
    volume += bar.volume;
    if (queue.length > length) {
      const removed = queue.shift();
      pv -= removed.weighted;
      volume -= removed.volume;
    }
    if (queue.length === length) output[i] = volume === 0 ? null : pv / volume;
  }
  return output;
}

export function calculateLatestIndicators(bars, { emaLength = 500, cciLength = 1200, vwapLength = bars?.length } = {}) {
  assertBars(bars, Math.max(emaLength, 21, cciLength, vwapLength));
  const closes = bars.map(bar => bar.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema = calculateEMA(closes, emaLength);
  const cci = calculateCCI(bars, cciLength);
  const vwap = calculateVWAP(bars, vwapLength);
  const last = bars.length - 1;
  return {
    timestamp: bars[last].timestamp,
    close: closes[last],
    ema9: ema9[last],
    ema21: ema21[last],
    ema: ema[last],
    cci: cci[last],
    vwap: vwap[last],
    candleCount: bars.length
  };
}

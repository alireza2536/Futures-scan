const DEFAULT_EMA_LENGTH = 500;

function assertBar(bar, timeframeMs) {
  if (!bar || !Number.isFinite(bar.timestamp) ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      bar.open <= 0 || bar.close <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high) || bar.volume < 0) {
    throw new Error("Invalid OHLCV candle");
  }
  if (bar.confirmed === false) throw new Error("Unclosed candle cannot enter EMA state");
  if (bar.timestamp % timeframeMs !== 0) throw new Error("Candle timestamp is not timeframe-aligned");
}

function calculateSeed(values, length) {
  const alpha = 2 / (length + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i += 1) value = alpha * values[i] + (1 - alpha) * value;
  return value;
}

// Initialize once from a verified contiguous history. The full seed history is
// not needed again after the resulting EMA state has been persisted.
export function createEmaState(bars, { timeframeMs, length = DEFAULT_EMA_LENGTH } = {}) {
  if (!Number.isInteger(timeframeMs) || timeframeMs <= 0) throw new Error("timeframeMs must be a positive integer");
  if (!Number.isInteger(length) || length < 1) throw new Error("EMA length must be a positive integer");
  if (!Array.isArray(bars) || bars.length < length) throw new Error(`At least ${length} closed candles are required to initialize EMA(${length})`);
  let previousTimestamp = null;
  for (const bar of bars) {
    assertBar(bar, timeframeMs);
    if (previousTimestamp !== null && bar.timestamp - previousTimestamp !== timeframeMs) {
      throw new Error("EMA seed history contains a gap, overlap, or duplicate");
    }
    previousTimestamp = bar.timestamp;
  }
  const last = bars.at(-1);
  const alpha = 2 / (length + 1);
  let value = bars[0].close;
  const history = [{ timestamp: bars[0].timestamp, close: bars[0].close, value }];
  for (let i = 1; i < bars.length; i += 1) {
    value = alpha * bars[i].close + (1 - alpha) * value;
    history.push({ timestamp: bars[i].timestamp, close: bars[i].close, value });
  }
  return {
    version: 1, length, timeframeMs, lastTimestamp: last.timestamp,
    lastClose: last.close, value, candlesProcessed: bars.length, history
  };
}

// Apply exactly one newly closed candle. No old exchange history is requested.
export function advanceEmaState(state, bar) {
  if (!state || state.version !== 1 || !Number.isInteger(state.length) ||
      !Number.isInteger(state.timeframeMs) || !Number.isFinite(state.value) ||
      !Number.isFinite(state.lastTimestamp)) throw new Error("Invalid EMA state");
  assertBar(bar, state.timeframeMs);
  if (bar.timestamp - state.lastTimestamp !== state.timeframeMs) {
    throw new Error("New candle must be the next contiguous closed candle");
  }
  const alpha = 2 / (state.length + 1);
  const value = alpha * bar.close + (1 - alpha) * state.value;
  return {
    ...state, lastTimestamp: bar.timestamp, lastClose: bar.close,
    value, candlesProcessed: state.candlesProcessed + 1
  };
}

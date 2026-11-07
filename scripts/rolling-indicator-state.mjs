const DEFAULT_CCI_LENGTH = 1000;

function assertValidBar(bar) {
  if (!bar || !Number.isFinite(bar.timestamp) ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      bar.open <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high) || bar.volume < 0) {
    throw new Error("Invalid OHLCV candle");
  }
  if (bar.confirmed === false) throw new Error("Unclosed candle cannot enter rolling state");
}

function typicalPrice(bar) {
  return (bar.high + bar.low + bar.close) / 3;
}

function calculateCciFromTypicalPrices(values, length) {
  if (values.length < length) return null;
  const window = values.slice(-length);
  const mean = window.reduce((sum, value) => sum + value, 0) / length;
  const meanDeviation = window.reduce((sum, value) => sum + Math.abs(value - mean), 0) / length;
  return meanDeviation === 0 ? 0 : (window.at(-1) - mean) / (0.015 * meanDeviation);
}

function utcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// Build compact state from verified closed candles. The project standard
// requires CCI length + one closed candle; CCI uses the latest CCI-length TP values.
export function createRollingIndicatorState(bars, { timeframeMs, cciLength = DEFAULT_CCI_LENGTH } = {}) {
  if (!Number.isInteger(timeframeMs) || timeframeMs <= 0) throw new Error("timeframeMs must be a positive integer");
  if (!Number.isInteger(cciLength) || cciLength < 1) throw new Error("cciLength must be a positive integer");
  if (!Array.isArray(bars) || bars.length < cciLength + 1) {
    throw new Error("At least " + (cciLength + 1) + " closed candles are required by the project history standard");
  }
  let previousTimestamp = null;
  for (const bar of bars) {
    assertValidBar(bar);
    if (bar.timestamp % timeframeMs !== 0) throw new Error("Candle timestamp is not timeframe-aligned");
    if (previousTimestamp !== null && bar.timestamp - previousTimestamp !== timeframeMs) {
      throw new Error("Candle history contains a gap, overlap, or duplicate");
    }
    previousTimestamp = bar.timestamp;
  }
  const lastBar = bars.at(-1);
  const session = utcDate(lastBar.timestamp);
  const sessionBars = bars.filter(bar => utcDate(bar.timestamp) === session);
  const sessionVolume = sessionBars.reduce((sum, bar) => sum + bar.volume, 0);
  const sessionPriceVolume = sessionBars.reduce((sum, bar) => sum + typicalPrice(bar) * bar.volume, 0);
  const typicalPrices = bars.slice(-cciLength).map(typicalPrice);
  return {
    version: 1, timeframeMs, cciLength, requiredClosedCandles: cciLength + 1,
    typicalPrices, lastTimestamp: lastBar.timestamp, sessionDateUtc: session,
    sessionPriceVolume, sessionVolume,
    cci: calculateCciFromTypicalPrices(typicalPrices, cciLength),
    vwap: sessionVolume === 0 ? null : sessionPriceVolume / sessionVolume
  };
}

// Advance by exactly one new closed candle; raw historical OHLCV is not retained.
export function advanceRollingIndicatorState(state, bar) {
  if (!state || state.version !== 1 || !Array.isArray(state.typicalPrices)) throw new Error("Invalid rolling indicator state");
  assertValidBar(bar);
  if (bar.timestamp % state.timeframeMs !== 0) throw new Error("Candle timestamp is not timeframe-aligned");
  if (bar.timestamp - state.lastTimestamp !== state.timeframeMs) {
    throw new Error("New candle must be the next contiguous closed candle");
  }
  const tp = typicalPrice(bar);
  const typicalPrices = [...state.typicalPrices, tp].slice(-state.cciLength);
  const date = utcDate(bar.timestamp);
  const sameSession = date === state.sessionDateUtc;
  const sessionPriceVolume = (sameSession ? state.sessionPriceVolume : 0) + tp * bar.volume;
  const sessionVolume = (sameSession ? state.sessionVolume : 0) + bar.volume;
  return {
    ...state, typicalPrices, lastTimestamp: bar.timestamp, sessionDateUtc: date,
    sessionPriceVolume, sessionVolume,
    cci: calculateCciFromTypicalPrices(typicalPrices, state.cciLength),
    vwap: sessionVolume === 0 ? null : sessionPriceVolume / sessionVolume
  };
}

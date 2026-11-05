export const LONG_RULE_LABELS = {
  "15m": "15m: CCI(1200)>170 AND EMA9>VWAP AND EMA9>EMA21",
  "1h": "1h: close>EMA2000 AND CCI(1200)>100",
  "2h": "2h: close>EMA2000 AND CCI(1200)>100",
  "4h": "4h: close>EMA500 AND CCI(1200)>100",
  "1d": "1d: close>EMA20 AND close>EMA50"
};

const TIMEFRAME_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};

export function isLongTimeframeSetup(timeframe, values) {
  if (!values || typeof values !== "object") return false;
  if (timeframe === "4h") {
    return Number.isFinite(values.close) && Number.isFinite(values.ema500) &&
      Number.isFinite(values.cci1200) && values.close > values.ema500 && values.cci1200 > 100;
  }
  if (timeframe === "2h" || timeframe === "1h") {
    return Number.isFinite(values.close) && Number.isFinite(values.ema2000) &&
      Number.isFinite(values.cci1200) && values.close > values.ema2000 && values.cci1200 > 100;
  }
  if (timeframe === "15m") {
    return Number.isFinite(values.cci1200) && Number.isFinite(values.ema9) &&
      Number.isFinite(values.ema21) && Number.isFinite(values.vwap) &&
      values.cci1200 > 170 && values.ema9 > values.vwap && values.ema9 > values.ema21;
  }
  if (timeframe === "1d") {
    return Number.isFinite(values.close) && Number.isFinite(values.ema20) &&
      Number.isFinite(values.ema50) && values.close > values.ema20 && values.close > values.ema50;
  }
  return false;
}

export function isLongSetupForSelectedTimeframes(valuesByTimeframe, selectedTimeframes) {
  if (!Array.isArray(selectedTimeframes) || selectedTimeframes.length === 0) return false;
  return selectedTimeframes.every(timeframe =>
    isLongTimeframeSetup(timeframe, valuesByTimeframe?.[timeframe])
  );
}

// Backward-compatible 4h helper used by existing tests and callers.
export function isLongSetup({ close, ema500, cci1200 }) {
  return isLongTimeframeSetup("4h", { close, ema500, cci1200 });
}

export function keepClosedCandles(bars, timeframe, now = Date.now()) {
  const duration = TIMEFRAME_MS[timeframe];
  if (!duration) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return bars.filter(bar => {
    if (bar.confirmed === false) return false;
    if (bar.confirmed === true) return true;
    return Number.isFinite(bar.timestamp) && bar.timestamp + duration <= now;
  });
}

export function keepClosedFourHourCandles(bars, now = Date.now()) {
  return keepClosedCandles(bars, "4h", now);
}

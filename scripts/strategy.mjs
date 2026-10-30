export function isLongSetup({ close, ema500, cci1200 }) {
  return Number.isFinite(close) &&
    Number.isFinite(ema500) &&
    Number.isFinite(cci1200) &&
    close > ema500 &&
    cci1200 > 100;
}

export function keepClosedFourHourCandles(bars, now = Date.now()) {
  const fourHoursMs = 4 * 60 * 60 * 1000;
  return bars.filter(bar => {
    if (bar.confirmed === false) return false;
    if (bar.confirmed === true) return true;
    return Number.isFinite(bar.timestamp) && bar.timestamp + fourHoursMs <= now;
  });
}

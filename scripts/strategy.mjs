export function isLongSetup({ cci1000 }) {
  return Number.isFinite(cci1000) && cci1000 > 100;
}

export function keepClosedFourHourCandles(bars, now = Date.now()) {
  const fourHoursMs = 4 * 60 * 60 * 1000;
  return bars.filter(bar => {
    if (bar.confirmed === false) return false;
    if (bar.confirmed === true) return true;
    return Number.isFinite(bar.timestamp) && bar.timestamp + fourHoursMs <= now;
  });
}

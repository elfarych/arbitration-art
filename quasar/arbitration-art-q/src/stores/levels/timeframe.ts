// Timeframe/duration helpers for the levels screener UI. A "gap" of N candles on
// a given timeframe spans a wall-clock duration, shown as a compact RU label
// (e.g. "30м", "1ч35м") in the screener filters and the analysis dialog.

// Minutes per candle for a Binance-style timeframe code (1m / 15m / 1h / 4h /
// 1d / 1w). Returns 0 for unknown codes so callers can hide the label.
export function timeframeMinutes(timeframe: string): number {
  const match = /^(\d+)([mhdw])$/.exec(timeframe);
  if (!match) return 0;
  const value = Number(match[1]);
  switch (match[2]) {
    case 'm':
      return value;
    case 'h':
      return value * 60;
    case 'd':
      return value * 1440;
    case 'w':
      return value * 10080;
    default:
      return 0;
  }
}

// Compact RU duration: 30 → "30м", 95 → "1ч35м", 1440 → "1д". Zero parts dropped.
export function formatDuration(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  let out = '';
  if (days) out += `${days}д`;
  if (hours) out += `${hours}ч`;
  if (minutes) out += `${minutes}м`;
  return out || '0м';
}

// Wall-clock span of `candles` candles on `timeframe`, as a compact RU label.
// Empty string when the timeframe is unknown or candles is not a positive number.
export function gapDuration(timeframe: string, candles: number): string {
  const perCandle = timeframeMinutes(timeframe);
  if (!perCandle || !(candles >= 1)) return '';
  return formatDuration(perCandle * Math.round(candles));
}

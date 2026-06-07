/** NATR — Normalized ATR (port of compute_natr from Python level_screener). */

import type { Candle } from './types';

/**
 * Current NATR in percent on the last candle.
 *
 * True Range = max(high−low, |high−prevClose|, |low−prevClose|); ATR — Wilder
 * smoothing (RMA, equivalent to EWM with alpha=1/period); NATR = ATR/close·100.
 */
export function computeNatr(candles: readonly Candle[], period: number): number {
  const n = candles.length;
  if (n === 0) {
    return 0;
  }

  let atr = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const current = candles[i];
    const prevClose = candles[i - 1].close;
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
    atr = (atr * (period - 1) + trueRange) / period;
  }

  const lastClose = candles[n - 1].close;
  return lastClose === 0 ? 0 : (atr / lastClose) * 100;
}

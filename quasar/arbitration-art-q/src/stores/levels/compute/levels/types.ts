/** Computational types for client-side level/analysis calculation.

MIRROR of art-level-screener/services/levels-api/src/levels/types.ts — see
../README.md. Keep in sync: the analysis must use the exact same shapes as the
screener, or the levels it finds would diverge. */

export type LevelKind = 'top' | 'bottom';
export type LevelSide = 'resistance' | 'support';

/** OHLCV candle as the connector stores it / Binance klines map to. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Level calculation parameters (resolved from levels-api /config + query). */
export interface LevelParams {
  period: number;
  extremaWindow: number;
  maxBrokenAge: number;
  minTouches: number;
  minGap: number;
  natrMultiplier: number;
  /**
   * Touch-zone tolerance as a direct % of price (band half-width). When set and
   * > 0 it overrides the adaptive `natr · natrMultiplier`. Mirrors levels-api.
   */
  tolerancePct?: number;
  atrPeriod: number;
}

/** Computational types for on-demand level calculation.

Copy kept in sync with `levels-api/src/levels/types.ts` (source of truth) and
`levels-processor/src/types/{candle,level}.ts`. Any change to level detection /
NATR / touches must be made in all copies (see `compute/README.md`), or the
notifier would find different levels than the screener. */

export type LevelKind = 'top' | 'bottom';
export type LevelSide = 'resistance' | 'support';

/** OHLCV candle as the connector stores it under `<sourcePrefix>:candles:<SYMBOL>:<tf>`. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Level calculation parameters (resolved per config from settings + env defaults). */
export interface LevelParams {
  period: number;
  extremaWindow: number;
  maxBrokenAge: number;
  minTouches: number;
  minGap: number;
  natrMultiplier: number;
  /**
   * Touch-zone tolerance as a direct % of price (band half-width). When set and
   * > 0 it overrides the adaptive `natr · natrMultiplier`. The notifier never
   * sets it (config uses natrMultiplier) — present to keep the shape in sync
   * with levels-api.
   */
  tolerancePct?: number;
  atrPeriod: number;
}

/** Internal level result before distance enrichment. */
export interface HorizontalLevel {
  time: number;
  index: number;
  price: number;
  kind: LevelKind;
  touches: number;
  breakoutDistance: number | null;
}

export interface LevelsResult {
  active: HorizontalLevel[];
  broken: HorizontalLevel[];
  price: number;
  natr: number;
}

/** Output level view: price, formation time and distance to current price. */
export interface LevelView {
  /** Level price. */
  price: number;
  /** Level formation time — open of the extremum candle (ms). */
  time: number;
  kind: LevelKind;
  /** Side relative to current price: above — resistance, below — support. */
  side: LevelSide;
  /** Real number of price touches. */
  touches: number;
  /** Distance to current price, % of price. */
  distancePct: number;
  /** Distance in NATR units (distancePct / natr); null if natr = 0. */
  distanceNatr: number | null;
  /** Breakout distance, % — only for broken levels, otherwise null. */
  breakoutDistance: number | null;
}

/** Per-symbol screen row (mirrors the levels-api/processor ScreenerEntry shape). */
export interface ScreenerEntry {
  symbol: string;
  price: number;
  natr: number;
  /** Active (unbroken) levels, sorted by proximity (NATR ↑). */
  levels: LevelView[];
  /** Nearest active level (= levels[0]); null when there are none. */
  nearest: LevelView | null;
  activeCount: number;
  brokenCount: number;
  updatedAt: number;
}

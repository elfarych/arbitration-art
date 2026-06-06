/** Computational types for on-demand level calculation.

Port kept in sync with `levels-processor/src/types/{candle,level}.ts`. The output
`LevelView` shape must stay structurally compatible with the `LevelView` TypeBox
schema in `../schemas/level.ts` (that schema is the wire contract). */

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

/** Level calculation parameters (resolved per request from query + env defaults). */
export interface LevelParams {
  period: number;
  extremaWindow: number;
  maxBrokenAge: number;
  minTouches: number;
  minGap: number;
  natrMultiplier: number;
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

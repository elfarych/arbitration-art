/** Horizontal level calculation (port of the improved Python level_screener).

Active/broken levels from significant extrema: a level is active if it is never
exceeded after itself; broken if exceeded exactly once, no older than
maxBrokenAge candles, and price is now beyond it. The touch-zone tolerance is
adaptive: tolerance% = natrMultiplier · NATR. Then real touches are counted for
each level and levels with touches < minTouches are dropped. */

import { computeNatr } from './natr';
import { countTouches } from './touches';
import { findExtrema } from './extrema';
import type { Candle, HorizontalLevel, LevelKind, LevelParams, LevelsResult } from './types';

export function calculateHorizontalLevels(
  candles: readonly Candle[],
  params: LevelParams,
): LevelsResult {
  const n = candles.length;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const price = candles[n - 1].close;
  const natr = computeNatr(candles, params.atrPeriod);
  // Tolerance is the touch-zone half-width in % of price. A caller-supplied
  // tolerancePct pins it directly; otherwise it is adaptive (natr · multiplier).
  const tolerancePct =
    params.tolerancePct != null && params.tolerancePct > 0
      ? params.tolerancePct
      : natr * params.natrMultiplier;

  const maxima = findExtrema(highs, params.period, false, params.extremaWindow);
  const minima = findExtrema(lows, params.period, true, params.extremaWindow);

  const active: HorizontalLevel[] = [];
  const broken: HorizontalLevel[] = [];
  processSide(maxima, highs, candles, 'top', price, params.maxBrokenAge, active, broken);
  processSide(minima, lows, candles, 'bottom', price, params.maxBrokenAge, active, broken);

  return {
    active: finalize(active, highs, lows, tolerancePct, params),
    broken: finalize(broken, highs, lows, tolerancePct, params),
    price,
    natr,
  };
}

function processSide(
  extrema: readonly number[],
  series: readonly number[],
  candles: readonly Candle[],
  kind: LevelKind,
  currentPrice: number,
  maxBrokenAge: number,
  active: HorizontalLevel[],
  broken: HorizontalLevel[],
): void {
  const isTop = kind === 'top';
  const n = series.length;

  for (const index of extrema) {
    const current = series[index];

    const breakRel = firstBreachFrom(series, index, current, isTop);
    if (breakRel === -1) {
      active.push(buildLevel(candles, index, current, kind, null));
      continue;
    }

    const firstBreakIdx = index + 1 + breakRel;
    if (firstBreachFrom(series, firstBreakIdx + 1, current, isTop) !== -1) {
      continue; // broken more than once — skip
    }

    const candlesSinceBreak = n - (index + breakRel);
    const priceBeyond = isTop ? currentPrice > current : currentPrice < current;
    if (candlesSinceBreak <= maxBrokenAge && priceBeyond) {
      const distance = breakoutDistance(series, current, maxBrokenAge, isTop);
      broken.push(buildLevel(candles, index, current, kind, distance));
    }
  }
}

/** Relative index of the first value breaching the level, or -1. */
function firstBreachFrom(
  series: readonly number[],
  start: number,
  level: number,
  isTop: boolean,
): number {
  for (let j = 0; start + j < series.length; j++) {
    const value = series[start + j];
    if (isTop ? value > level : value < level) {
      return j;
    }
  }
  return -1;
}

function breakoutDistance(
  series: readonly number[],
  level: number,
  maxBrokenAge: number,
  isTop: boolean,
): number {
  const recent = series.slice(-maxBrokenAge);
  if (isTop) {
    return ((Math.max(...recent) - level) / level) * 100;
  }
  return ((level - Math.min(...recent)) / level) * 100;
}

function finalize(
  levels: readonly HorizontalLevel[],
  highs: readonly number[],
  lows: readonly number[],
  tolerancePct: number,
  params: LevelParams,
): HorizontalLevel[] {
  const result: HorizontalLevel[] = [];
  for (const level of levels) {
    const series = level.kind === 'top' ? highs : lows;
    // Touches are counted only AFTER the level formed (candles to the right of
    // the extremum). The extremum that created the level is the level itself,
    // not a touch, and pre-formation price action must not inflate the count.
    // previousInside=true seeds the "price was at the level on formation" state
    // so the residual in-band candles right after the extremum aren't counted —
    // only genuine returns to the band do.
    const afterFormation = series.slice(level.index + 1);
    const touches = countTouches(level.price, afterFormation, tolerancePct, params.minGap, true);
    if (touches >= params.minTouches) {
      result.push({ ...level, touches });
    }
  }
  return result;
}

function buildLevel(
  candles: readonly Candle[],
  index: number,
  price: number,
  kind: LevelKind,
  breakoutDistanceValue: number | null,
): HorizontalLevel {
  return {
    time: candles[index].openTime,
    index,
    price,
    kind,
    touches: 0,
    breakoutDistance: breakoutDistanceValue,
  };
}

/** Расчёт горизонтальных уровней (порт улучшенного Python level_screener).

Активные/пробитые уровни из значимых экстремумов: уровень active, если после
себя ни разу не превышен; broken — превышен ровно один раз, не старше
maxBrokenAge свечей, и цена сейчас по ту сторону. Допуск зоны касания адаптивен:
tolerance% = natrMultiplier · NATR. Затем для каждого уровня считаются реальные
касания ценой и отбрасываются уровни с touches < minTouches. */

import { computeNatr } from './natr';
import { countTouches } from './touches';
import { findExtrema } from './extrema';
import type { Candle } from '../types/candle';
import type { HorizontalLevel, LevelKind, LevelParams, LevelsResult } from '../types/level';

export function calculateHorizontalLevels(
  candles: readonly Candle[],
  params: LevelParams,
): LevelsResult {
  const n = candles.length;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const price = candles[n - 1].close;
  const natr = computeNatr(candles, params.atrPeriod);
  // A caller-supplied tolerancePct pins the touch-zone half-width directly;
  // otherwise it stays adaptive (natr · multiplier). See levels-api source.
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
      continue; // пробит более одного раза — пропускаем
    }

    const candlesSinceBreak = n - (index + breakRel);
    const priceBeyond = isTop ? currentPrice > current : currentPrice < current;
    if (candlesSinceBreak <= maxBrokenAge && priceBeyond) {
      const distance = breakoutDistance(series, current, maxBrokenAge, isTop);
      broken.push(buildLevel(candles, index, current, kind, distance));
    }
  }
}

/** Относительный индекс первого значения, пробивающего уровень, либо -1. */
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

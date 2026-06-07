/** Enriching levels with distance to current price and sorting by proximity. */

import type { HorizontalLevel, LevelView } from './types';

/** Convert a level to its output view with distance to price. */
export function toLevelView(level: HorizontalLevel, price: number, natr: number): LevelView {
  const distancePct = (Math.abs(level.price - price) / price) * 100;
  return {
    price: level.price,
    time: level.time,
    kind: level.kind,
    side: level.price >= price ? 'resistance' : 'support',
    touches: level.touches,
    distancePct,
    distanceNatr: natr > 0 ? distancePct / natr : null,
    breakoutDistance: level.breakoutDistance,
  };
}

/** Enrich a set of levels and sort by proximity (NATR ↑, nearest first). */
export function buildLevelViews(
  levels: readonly HorizontalLevel[],
  price: number,
  natr: number,
): LevelView[] {
  return levels
    .map((level) => toLevelView(level, price, natr))
    .sort((a, b) => distanceKey(a) - distanceKey(b));
}

function distanceKey(view: LevelView): number {
  return view.distanceNatr ?? Number.POSITIVE_INFINITY;
}

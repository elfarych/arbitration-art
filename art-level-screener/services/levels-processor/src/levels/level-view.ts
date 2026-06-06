/** Обогащение уровней дистанцией до текущей цены и сортировка по близости. */

import type { HorizontalLevel, LevelView } from '../types/level';

/** Преобразовать уровень в выходной вид с дистанцией до цены. */
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

/** Обогатить набор уровней и отсортировать по близости (NATR ↑, ближайший первым). */
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

/** Подсчёт реальных касаний ценой уровня (порт _count_touches). */

/**
 * Сколько раз цена отдельно подходила к уровню в пределах допуска.
 *
 * Касание — вход цены в полосу `±tolerancePct` вокруг уровня после выхода из
 * неё. Подходы, разделённые менее чем `minGap` свечами, считаются одним
 * касанием — это гасит короткие проколы границы зоны у одной вершины/впадины.
 * `series` — highs для top-уровня, lows для bottom.
 *
 * `previousInsideInit` — было ли «внутри полосы» непосредственно перед началом
 * серии. При подсчёте касаний справа от экстремума передаётся `true` (на
 * формировании цена была у уровня), чтобы остаточные свечи сразу после пика не
 * засчитались как новый вход — считаются только реальные возвраты к уровню.
 */
export function countTouches(
  price: number,
  series: readonly number[],
  tolerancePct: number,
  minGap: number,
  previousInsideInit = false,
): number {
  const band = (price * tolerancePct) / 100;
  const lower = price - band;
  const upper = price + band;

  let touches = 0;
  let lastCounted = Number.NEGATIVE_INFINITY;
  let previousInside = previousInsideInit;

  for (let i = 0; i < series.length; i++) {
    const inside = series[i] >= lower && series[i] <= upper;
    const isEntry = inside && !previousInside;
    if (isEntry && i - lastCounted >= minGap) {
      touches += 1;
      lastCounted = i;
    }
    previousInside = inside;
  }
  return touches;
}

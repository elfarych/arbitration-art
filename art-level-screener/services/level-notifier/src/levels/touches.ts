/** Counting real price touches of a level (port of _count_touches). */

/**
 * How many times price separately approached the level within tolerance.
 *
 * A touch is price entering the `±tolerancePct` band around the level after
 * leaving it. Approaches separated by fewer than `minGap` candles count as one
 * touch — this damps short pokes through the zone boundary near one peak/trough.
 * `series` — highs for a top level, lows for a bottom one.
 *
 * `previousInsideInit` — whether price was "inside the band" right before the
 * series starts. When counting touches to the right of the extremum it is `true`
 * (on formation price was at the level), so the residual candles right after the
 * peak are not counted as a new entry — only genuine returns to the level are.
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

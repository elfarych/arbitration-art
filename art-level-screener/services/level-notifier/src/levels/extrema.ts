/** Significant extrema search (port of find_extrema from Python level_screener). */

/**
 * Indices of significant extrema of a series.
 *
 * A candle is an extremum if its value is not worse than all `order` neighbours
 * on both sides (non-strict comparison). The right edge window is truncated; the
 * last `lastWindow` candles are never extrema. Allocation-free (no slice) with
 * early exit — O(n·order) worst case.
 */
export function findExtrema(
  values: readonly number[],
  order: number,
  isMinima: boolean,
  lastWindow: number,
): number[] {
  if (order < 1) {
    throw new Error('order должен быть >= 1');
  }
  const n = values.length;
  const limit = n - lastWindow;
  const result: number[] = [];

  for (let i = order; i < limit; i++) {
    const value = values[i];
    if (!dominatesLeft(values, i, order, value, isMinima)) {
      continue;
    }
    if (dominatesRight(values, i, order, n, value, isMinima)) {
      result.push(i);
    }
  }
  return result;
}

function dominatesLeft(
  values: readonly number[],
  i: number,
  order: number,
  value: number,
  isMinima: boolean,
): boolean {
  for (let j = i - order; j < i; j++) {
    if (isMinima ? values[j] < value : values[j] > value) {
      return false;
    }
  }
  return true;
}

function dominatesRight(
  values: readonly number[],
  i: number,
  order: number,
  n: number,
  value: number,
  isMinima: boolean,
): boolean {
  const end = Math.min(i + order + 1, n);
  for (let j = i + 1; j < end; j++) {
    if (isMinima ? values[j] < value : values[j] > value) {
      return false;
    }
  }
  return true;
}

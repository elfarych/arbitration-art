/** Поиск значимых экстремумов (порт find_extrema из Python level_screener). */

/**
 * Индексы значимых экстремумов серии.
 *
 * Свеча — экстремум, если её значение не уступает всем `order` соседям слева и
 * справа (нестрогое сравнение). У правого края окно усекается; последние
 * `lastWindow` свечей экстремумами не считаются. Реализация без аллокаций
 * (без slice) с ранним выходом — O(n·order) в худшем случае.
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

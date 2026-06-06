/** Фильтрация, сортировка и пагинация записей скринера (поверх Redis-данных). */

import type { ScreenerEntryType, ScreenerQueryType } from '../schemas/level';

export interface ScreenerPage {
  total: number;
  items: ScreenerEntryType[];
}

/**
 * Применить query к списку монет.
 *
 * Данные из Redis уже отсортированы по `distanceNatr ↑`; здесь — фильтры,
 * опциональная пересортировка и срез по `offset`/`limit`. `total` — число монет
 * после фильтров (до пагинации).
 */
export function applyScreenerQuery(
  entries: readonly ScreenerEntryType[],
  query: ScreenerQueryType,
): ScreenerPage {
  const filtered = entries.filter((entry) => matches(entry, query));
  const sorted = sortEntries(filtered, query);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? sorted.length;
  return { total: sorted.length, items: sorted.slice(offset, offset + limit) };
}

function matches(entry: ScreenerEntryType, query: ScreenerQueryType): boolean {
  if (query.side && entry.nearest?.side !== query.side) {
    return false;
  }
  if (query.maxDistanceNatr !== undefined) {
    const distance = entry.nearest?.distanceNatr;
    if (distance === null || distance === undefined || distance > query.maxDistanceNatr) {
      return false;
    }
  }
  if (query.minActive !== undefined && entry.activeCount < query.minActive) {
    return false;
  }
  if (query.search && !entry.symbol.includes(query.search.toUpperCase())) {
    return false;
  }
  return true;
}

function sortEntries(
  entries: readonly ScreenerEntryType[],
  query: ScreenerQueryType,
): ScreenerEntryType[] {
  const direction = query.order === 'desc' ? -1 : 1;
  const sort = query.sort ?? 'distance';
  return [...entries].sort((a, b) => direction * compare(a, b, sort));
}

function compare(a: ScreenerEntryType, b: ScreenerEntryType, sort: string): number {
  if (sort === 'symbol') {
    return a.symbol.localeCompare(b.symbol);
  }
  if (sort === 'natr') {
    return a.natr - b.natr;
  }
  return distanceNatr(a) - distanceNatr(b);
}

function distanceNatr(entry: ScreenerEntryType): number {
  return entry.nearest?.distanceNatr ?? Number.POSITIVE_INFINITY;
}

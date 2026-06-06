/** Поддерживаемые таймфреймы и утилиты выравнивания границ интервалов. */

export const TIMEFRAME_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
} as const;

export type Timeframe = keyof typeof TIMEFRAME_MINUTES;

/** Базовый таймфрейм, по которому идёт сокет и из которого агрегируются старшие. */
export const BASE_TIMEFRAME: Timeframe = '1m';

export function isTimeframe(value: string): value is Timeframe {
  return value in TIMEFRAME_MINUTES;
}

export function timeframeMs(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe] * 60_000;
}

/** Начало интервала таймфрейма, в который попадает момент `openTimeMs`. */
export function bucketStart(openTimeMs: number, timeframe: Timeframe): number {
  const size = timeframeMs(timeframe);
  return Math.floor(openTimeMs / size) * size;
}

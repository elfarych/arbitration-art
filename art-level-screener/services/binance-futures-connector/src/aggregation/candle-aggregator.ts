/** Состояние свечей в памяти и агрегация 1m → старшие таймфреймы.

Для каждого символа хранятся серии по всем таймфреймам. История наполняется
снапшотами (REST), затем поддерживается live: на каждый апдейт 1m обновляется
1m-серия и пересчитывается текущий формирующийся бар каждого старшего ТФ из
1m-свечей соответствующего интервала. */

import { BASE_TIMEFRAME, bucketStart, timeframeMs, type Timeframe } from './timeframe';
import type { Candle } from '../types/candle';

export class CandleAggregator {
  private readonly store = new Map<string, Map<Timeframe, Candle[]>>();
  private readonly lastEventAt = new Map<string, number>();
  private readonly higherTimeframes: Timeframe[];

  constructor(
    private readonly timeframes: readonly Timeframe[],
    private readonly depth: number,
  ) {
    this.higherTimeframes = timeframes.filter((tf) => tf !== BASE_TIMEFRAME);
  }

  hasSymbol(symbol: string): boolean {
    return this.store.has(symbol);
  }

  removeSymbol(symbol: string): void {
    this.store.delete(symbol);
    this.lastEventAt.delete(symbol);
  }

  /** Время (мс) последнего применённого live-апдейта 1m для символа. */
  lastUpdatedAt(symbol: string): number | undefined {
    return this.lastEventAt.get(symbol);
  }

  /** Заполнить серию таймфрейма историей из снапшота. */
  seed(symbol: string, timeframe: Timeframe, candles: Candle[]): void {
    const series = candles.slice(-this.depth);
    this.symbolSeries(symbol).set(timeframe, series);
  }

  getSeries(symbol: string, timeframe: Timeframe): Candle[] {
    return this.symbolSeries(symbol).get(timeframe) ?? [];
  }

  /** Последняя цена символа — close последней 1m-свечи. */
  lastPrice(symbol: string): number | undefined {
    const base = this.getSeries(symbol, BASE_TIMEFRAME);
    return base.at(-1)?.close;
  }

  /** Применить апдейт 1m-свечи: обновить базу и пересчитать старшие ТФ. */
  applyKline1m(symbol: string, candle: Candle): void {
    if (!this.store.has(symbol)) {
      return;
    }
    this.lastEventAt.set(symbol, Date.now());
    this.upsert(this.getSeries(symbol, BASE_TIMEFRAME), candle);

    for (const timeframe of this.higherTimeframes) {
      const start = bucketStart(candle.openTime, timeframe);
      const aggregated = this.aggregateBucket(symbol, timeframe, start);
      if (aggregated) {
        this.upsert(this.getSeries(symbol, timeframe), aggregated);
      }
    }
  }

  private aggregateBucket(symbol: string, timeframe: Timeframe, start: number): Candle | null {
    const end = start + timeframeMs(timeframe);
    const base = this.getSeries(symbol, BASE_TIMEFRAME);

    let open: number | undefined;
    let high = -Infinity;
    let low = Infinity;
    let close = 0;
    let volume = 0;

    for (const minute of base) {
      if (minute.openTime < start || minute.openTime >= end) {
        continue;
      }
      if (open === undefined) {
        open = minute.open;
      }
      high = Math.max(high, minute.high);
      low = Math.min(low, minute.low);
      close = minute.close;
      volume += minute.volume;
    }

    if (open === undefined) {
      return null;
    }
    return { openTime: start, open, high, low, close, volume };
  }

  /** Вставить/обновить свечу в конце серии, удерживая глубину и порядок. */
  private upsert(series: Candle[], candle: Candle): void {
    const last = series.at(-1);
    if (last && last.openTime === candle.openTime) {
      series[series.length - 1] = candle;
      return;
    }
    if (!last || candle.openTime > last.openTime) {
      series.push(candle);
      if (series.length > this.depth) {
        series.shift();
      }
    }
  }

  private symbolSeries(symbol: string): Map<Timeframe, Candle[]> {
    let series = this.store.get(symbol);
    if (!series) {
      series = new Map<Timeframe, Candle[]>();
      this.store.set(symbol, series);
    }
    return series;
  }
}

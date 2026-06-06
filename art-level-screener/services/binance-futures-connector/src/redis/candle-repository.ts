/** Запись свечей, цен и списка символов в Redis.

Схема ключей (prefix по умолчанию `binance-futures`):
  <prefix>:candles:<SYMBOL>:<tf>  — JSON-массив свечей [{openTime,open,high,low,close,volume}]
  <prefix>:price:<SYMBOL>         — последняя цена (число)
  <prefix>:updated:<SYMBOL>       — время (мс) последнего live-апдейта (свежесть)
  <prefix>:symbols               — JSON-массив активных символов

Свеча хранится целым массивом-объектами OHLCV под одним ключом: потребитель
(сервис уровней) читает всю серию одним GET и считает уровни и дистанцию. */

import type { Redis } from 'ioredis';

import type { Timeframe } from '../aggregation/timeframe';
import type { Candle } from '../types/candle';

export interface SymbolSnapshot {
  symbol: string;
  series: Map<Timeframe, Candle[]>;
  price: number | undefined;
  updatedAt: number | undefined;
}

export class CandleRepository {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  /** Пакетно записать серии и цены группы символов (один pipeline). */
  async writeBatch(snapshots: readonly SymbolSnapshot[]): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const snapshot of snapshots) {
      for (const [timeframe, candles] of snapshot.series) {
        pipeline.set(this.candleKey(snapshot.symbol, timeframe), JSON.stringify(candles));
      }
      if (snapshot.price !== undefined) {
        pipeline.set(this.priceKey(snapshot.symbol), String(snapshot.price));
      }
      if (snapshot.updatedAt !== undefined) {
        pipeline.set(this.updatedKey(snapshot.symbol), String(snapshot.updatedAt));
      }
    }
    await pipeline.exec();
  }

  async setSymbols(symbols: readonly string[]): Promise<void> {
    await this.redis.set(this.symbolsKey(), JSON.stringify(symbols));
  }

  /** Удалить все данные символа (свечи всех ТФ и цену). */
  async removeSymbol(symbol: string, timeframes: readonly Timeframe[]): Promise<void> {
    const keys = timeframes.map((timeframe) => this.candleKey(symbol, timeframe));
    keys.push(this.priceKey(symbol), this.updatedKey(symbol));
    await this.redis.del(...keys);
  }

  private candleKey(symbol: string, timeframe: Timeframe): string {
    return `${this.prefix}:candles:${symbol}:${timeframe}`;
  }

  private priceKey(symbol: string): string {
    return `${this.prefix}:price:${symbol}`;
  }

  private updatedKey(symbol: string): string {
    return `${this.prefix}:updated:${symbol}`;
  }

  private symbolsKey(): string {
    return `${this.prefix}:symbols`;
  }
}

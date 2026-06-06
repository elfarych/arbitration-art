/** Чтение свечей и списка символов из Redis (то, что пишет коннектор). */

import type { Redis } from 'ioredis';

import type { Candle } from '../types/candle';

export type CandleMap = Map<string, Map<string, Candle[]>>;

export class CandleSource {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async getSymbols(): Promise<string[]> {
    const raw = await this.redis.get(`${this.prefix}:symbols`);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }

  /**
   * Загрузить свечи для всех пар символ×таймфрейм одним `MGET`.
   * Возвращает вложенную карту symbol → timeframe → свечи.
   */
  async getCandles(symbols: readonly string[], timeframes: readonly string[]): Promise<CandleMap> {
    const keys: string[] = [];
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        keys.push(this.candleKey(symbol, timeframe));
      }
    }
    if (keys.length === 0) {
      return new Map();
    }

    const values = await this.redis.mget(keys);
    const map: CandleMap = new Map();
    let cursor = 0;
    for (const symbol of symbols) {
      const bySymbol = new Map<string, Candle[]>();
      for (const timeframe of timeframes) {
        const candles = parseCandles(values[cursor]);
        cursor += 1;
        if (candles) {
          bySymbol.set(timeframe, candles);
        }
      }
      map.set(symbol, bySymbol);
    }
    return map;
  }

  private candleKey(symbol: string, timeframe: string): string {
    return `${this.prefix}:candles:${symbol}:${timeframe}`;
  }
}

function parseCandles(raw: string | null): Candle[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Candle[]) : null;
  } catch {
    return null;
  }
}

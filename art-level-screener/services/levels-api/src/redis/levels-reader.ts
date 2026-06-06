/** Чтение рассчитанных уровней из Redis (пишет levels-processor). */

import type { Redis } from 'ioredis';

import type { ScreenerEntryType, SymbolDetailType } from '../schemas/level';

export class LevelsReader {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async getTimeframes(): Promise<string[]> {
    return (await this.readJson<string[]>(`${this.prefix}:timeframes`)) ?? [];
  }

  /** Экран скринера по таймфрейму (уже отсортирован по близости); null если нет. */
  async getScreener(timeframe: string): Promise<ScreenerEntryType[] | null> {
    return this.readJson<ScreenerEntryType[]>(`${this.prefix}:screener:${timeframe}`);
  }

  /** Полные уровни монеты; null если нет. */
  async getDetail(timeframe: string, symbol: string): Promise<SymbolDetailType | null> {
    return this.readJson<SymbolDetailType>(`${this.prefix}:detail:${timeframe}:${symbol}`);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

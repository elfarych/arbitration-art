/** Запись рассчитанных уровней в Redis под будущий API-скринер.

Схема ключей (prefix по умолчанию `levels`):
  <prefix>:screener:<tf>          — JSON-массив ScreenerEntry, сортирован по
                                    близости (distanceNatr ↑) — экран скринера
  <prefix>:detail:<tf>:<SYMBOL>   — JSON SymbolDetail (полные уровни) для drill-down
  <prefix>:timeframes             — JSON-массив обрабатываемых ТФ

На ключи ставится TTL: если процессор перестаёт писать символ/ТФ (монета
выбыла), данные сами исчезают — API всегда видит только актуальное. */

import type { Redis } from 'ioredis';

import type { ScreenerEntry, SymbolDetail } from '../types/level';

export interface TimeframeOutput {
  index: ScreenerEntry[];
  details: Map<string, SymbolDetail>;
}

export class LevelsRepository {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlMs: number,
  ) {}

  /** Записать индексы и детали по всем таймфреймам одним pipeline. */
  async write(perTimeframe: Map<string, TimeframeOutput>): Promise<void> {
    const pipeline = this.redis.pipeline();

    for (const [timeframe, output] of perTimeframe) {
      pipeline.set(this.screenerKey(timeframe), JSON.stringify(output.index), 'PX', this.ttlMs);
      for (const [symbol, detail] of output.details) {
        pipeline.set(this.detailKey(timeframe, symbol), JSON.stringify(detail), 'PX', this.ttlMs);
      }
    }

    pipeline.set(this.timeframesKey(), JSON.stringify([...perTimeframe.keys()]), 'PX', this.ttlMs);
    await pipeline.exec();
  }

  private screenerKey(timeframe: string): string {
    return `${this.prefix}:screener:${timeframe}`;
  }

  private detailKey(timeframe: string, symbol: string): string {
    return `${this.prefix}:detail:${timeframe}:${symbol}`;
  }

  private timeframesKey(): string {
    return `${this.prefix}:timeframes`;
  }
}

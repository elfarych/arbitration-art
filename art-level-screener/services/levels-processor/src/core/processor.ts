/** Один проход обработки: читать свечи → считать уровни → писать в Redis. */

import { calculateHorizontalLevels } from '../levels/horizontal-levels';
import { buildLevelViews } from '../levels/level-view';
import type { CandleSource } from '../redis/candle-source';
import type { Config } from '../config/env';
import type { LevelsRepository, TimeframeOutput } from '../redis/levels-repository';
import type { Logger } from '../utils/logger';
import type { Candle } from '../types/candle';
import type { ScreenerEntry, SymbolDetail } from '../types/level';

export class Processor {
  constructor(
    private readonly source: CandleSource,
    private readonly repository: LevelsRepository,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    const startedAt = Date.now();
    const symbols = await this.source.getSymbols();
    if (symbols.length === 0) {
      this.logger.warn('источник не содержит символов');
      return;
    }

    const candleMap = await this.source.getCandles(symbols, this.config.timeframes);
    const perTimeframe = this.initOutputs();

    for (const symbol of symbols) {
      const bySymbol = candleMap.get(symbol);
      if (!bySymbol) {
        continue;
      }
      for (const timeframe of this.config.timeframes) {
        const candles = bySymbol.get(timeframe);
        if (candles && this.isSufficient(candles)) {
          this.processSymbol(symbol, timeframe, candles, startedAt, perTimeframe);
        }
      }
    }

    this.sortIndices(perTimeframe);
    await this.repository.write(perTimeframe);
    this.logger.info(
      { symbols: symbols.length, timeframes: this.config.timeframes.length, ms: Date.now() - startedAt },
      'обработано',
    );
  }

  private processSymbol(
    symbol: string,
    timeframe: string,
    candles: Candle[],
    updatedAt: number,
    perTimeframe: Map<string, TimeframeOutput>,
  ): void {
    const result = calculateHorizontalLevels(candles, this.config.levels);
    const active = buildLevelViews(result.active, result.price, result.natr);
    const broken = buildLevelViews(result.broken, result.price, result.natr);
    const nearest = active[0] ?? null;

    const detail: SymbolDetail = {
      symbol,
      timeframe,
      price: result.price,
      natr: result.natr,
      nearest,
      active,
      broken,
      updatedAt,
    };
    const entry: ScreenerEntry = {
      symbol,
      price: result.price,
      natr: result.natr,
      levels: active,
      nearest,
      activeCount: active.length,
      brokenCount: broken.length,
      updatedAt,
    };

    const output = perTimeframe.get(timeframe);
    if (output) {
      output.details.set(symbol, detail);
      output.index.push(entry);
    }
  }

  private initOutputs(): Map<string, TimeframeOutput> {
    const perTimeframe = new Map<string, TimeframeOutput>();
    for (const timeframe of this.config.timeframes) {
      perTimeframe.set(timeframe, { index: [], details: new Map() });
    }
    return perTimeframe;
  }

  private sortIndices(perTimeframe: Map<string, TimeframeOutput>): void {
    for (const output of perTimeframe.values()) {
      output.index.sort((a, b) => distanceKey(a) - distanceKey(b));
    }
  }

  private isSufficient(candles: Candle[]): boolean {
    return candles.length > this.config.levels.period + this.config.levels.extremaWindow;
  }
}

/** Ключ сортировки: ближе по NATR — выше; без уровней — в конец. */
function distanceKey(entry: ScreenerEntry): number {
  return entry.nearest?.distanceNatr ?? Number.POSITIVE_INFINITY;
}

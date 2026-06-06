/** Коннектор: до N символов на одном 1m-сокете, снапшот + live-агрегация.

Защита от гэпа: перед снапшотом включается буферизация live-апдейтов 1m, затем
тянется история (REST), серии заполняются, и буфер «доливается» поверх — между
снапшотом и сокетом данные не теряются. Тот же приём при добавлении символов и
при reconnect (переснапшот по событию `open`). Раз в `flushMs` всё пишется в
Redis одним pipeline. */

import { CandleAggregator } from '../aggregation/candle-aggregator';
import { KlineStream, type Kline1mUpdate } from '../binance/kline-stream';
import type { BinanceRestClient } from '../binance/rest-client';
import type { Timeframe } from '../aggregation/timeframe';
import type { Candle } from '../types/candle';
import type { CandleRepository, SymbolSnapshot } from '../redis/candle-repository';
import type { Logger } from '../utils/logger';

export interface ConnectorDeps {
  rest: BinanceRestClient;
  repository: CandleRepository;
  logger: Logger;
  wsBaseUrl: string;
  wsStaleTimeoutMs: number;
  timeframes: Timeframe[];
  snapshotDepth: number;
  capacity: number;
  flushMs: number;
}

export class Connector {
  private readonly aggregator: CandleAggregator;
  private readonly stream: KlineStream;
  private readonly symbols = new Set<string>();
  private readonly buffer = new Map<string, Candle[]>();
  private flushTimer: NodeJS.Timeout | undefined;
  private opened = false;

  constructor(
    readonly id: string,
    private readonly deps: ConnectorDeps,
  ) {
    this.aggregator = new CandleAggregator(deps.timeframes, deps.snapshotDepth);
    this.stream = new KlineStream(
      deps.wsBaseUrl,
      deps.logger.child({ connector: id }),
      deps.wsStaleTimeoutMs,
    );
  }

  get size(): number {
    return this.symbols.size;
  }

  get availableSlots(): number {
    return this.deps.capacity - this.symbols.size;
  }

  hasCapacity(): boolean {
    return this.symbols.size < this.deps.capacity;
  }

  /** Запустить коннектор со стартовым набором символов. */
  async start(symbols: readonly string[]): Promise<void> {
    this.bindStream();
    this.reserve(symbols);
    this.stream.start(symbols);
    await this.onboard(symbols);
    this.startFlushLoop();
    this.deps.logger.info({ connector: this.id, symbols: symbols.length }, 'коннектор запущен');
  }

  /** Добавить символы в уже работающий коннектор (без переподключения). */
  async addSymbols(symbols: readonly string[]): Promise<void> {
    this.reserve(symbols);
    this.stream.addSymbols(symbols);
    await this.onboard(symbols);
    this.deps.logger.info({ connector: this.id, added: symbols.length }, 'символы добавлены');
  }

  /** Удалить символы из коннектора и стереть их данные в Redis. */
  async removeSymbols(symbols: readonly string[]): Promise<void> {
    this.stream.removeSymbols(symbols);
    for (const symbol of symbols) {
      this.symbols.delete(symbol);
      this.buffer.delete(symbol);
      this.aggregator.removeSymbol(symbol);
      await this.deps.repository.removeSymbol(symbol, this.deps.timeframes);
    }
    this.deps.logger.info({ connector: this.id, removed: symbols.length }, 'символы удалены');
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.stream.stop();
  }

  private bindStream(): void {
    this.stream.on('kline', (update) => this.handleKline(update));
    this.stream.on('open', () => {
      if (!this.opened) {
        this.opened = true;
        return;
      }
      // Reconnect: переснапшот закрывает возможный гэп за время обрыва.
      this.onboard([...this.symbols]).catch((error) =>
        this.deps.logger.error({ connector: this.id, err: error }, 'ошибка переснапшота'),
      );
    });
  }

  private handleKline(update: Kline1mUpdate): void {
    const pending = this.buffer.get(update.symbol);
    if (pending) {
      pending.push(update.candle);
      return;
    }
    this.aggregator.applyKline1m(update.symbol, update.candle);
  }

  /** Снять снапшот, засеять серии и долить буфер (gap-safe). */
  private async onboard(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) {
      this.buffer.set(symbol, this.buffer.get(symbol) ?? []);
    }
    for (const symbol of symbols) {
      await this.seedSymbol(symbol);
    }
    for (const symbol of symbols) {
      this.drain(symbol);
    }
  }

  private async seedSymbol(symbol: string): Promise<void> {
    try {
      for (const timeframe of this.deps.timeframes) {
        const candles = await this.deps.rest.klines(symbol, timeframe, this.deps.snapshotDepth);
        this.aggregator.seed(symbol, timeframe, candles);
      }
    } catch (error) {
      this.deps.logger.error({ connector: this.id, symbol, err: error }, 'ошибка снапшота');
    }
  }

  private drain(symbol: string): void {
    const pending = this.buffer.get(symbol) ?? [];
    this.buffer.delete(symbol);
    for (const candle of pending) {
      this.aggregator.applyKline1m(symbol, candle);
    }
  }

  private reserve(symbols: readonly string[]): void {
    for (const symbol of symbols) {
      this.symbols.add(symbol);
    }
  }

  private startFlushLoop(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((error) =>
        this.deps.logger.error({ connector: this.id, err: error }, 'ошибка записи в Redis'),
      );
    }, this.deps.flushMs);
  }

  private async flush(): Promise<void> {
    const snapshots: SymbolSnapshot[] = [...this.symbols].map((symbol) => ({
      symbol,
      price: this.aggregator.lastPrice(symbol),
      updatedAt: this.aggregator.lastUpdatedAt(symbol),
      series: new Map(
        this.deps.timeframes.map((timeframe) => [
          timeframe,
          this.aggregator.getSeries(symbol, timeframe),
        ]),
      ),
    }));
    await this.deps.repository.writeBatch(snapshots);
  }
}

/** Оркестратор коннекторов: discovery, распределение символов, ребаланс.

При старте символы (USDT-перпетуалы с объёмом ≥ порога) делятся на группы по
`symbolsPerConnector`, каждая — отдельный коннектор. Раз в `refreshMs` набор
пересчитывается без рестарта: выбывшие символы (объём упал / делистинг)
удаляются вместе с данными в Redis; новые доливаются в коннектор со свободными
слотами либо в новый. */

import { Connector } from './connector';
import type { SymbolDiscovery } from '../binance/symbol-discovery';
import type { BinanceRestClient } from '../binance/rest-client';
import type { CandleRepository } from '../redis/candle-repository';
import type { Config } from '../config/env';
import type { Logger } from '../utils/logger';
import { chunk } from '../utils/async';

export interface ManagerDeps {
  discovery: SymbolDiscovery;
  rest: BinanceRestClient;
  repository: CandleRepository;
  config: Config;
  logger: Logger;
}

export class ConnectorManager {
  private readonly connectors: Connector[] = [];
  private readonly symbolToConnector = new Map<string, Connector>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private connectorSeq = 0;

  constructor(private readonly deps: ManagerDeps) {}

  async start(): Promise<void> {
    const discovered = await this.discover();
    const groups = chunk(
      discovered.map((entry) => entry.symbol),
      this.deps.config.connector.symbolsPerConnector,
    );

    for (const group of groups) {
      const connector = this.createConnector();
      this.connectors.push(connector);
      await connector.start(group);
      for (const symbol of group) {
        this.symbolToConnector.set(symbol, connector);
      }
    }

    await this.deps.repository.setSymbols(this.currentSymbols());
    this.scheduleRefresh();
    this.deps.logger.info(
      { connectors: this.connectors.length, symbols: this.symbolToConnector.size },
      'менеджер запущен',
    );
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await Promise.all(this.connectors.map((connector) => connector.stop()));
  }

  /** Ежечасная ребалансировка набора символов без полного перезапуска. */
  async refresh(): Promise<void> {
    const discovered = await this.discover();
    const nextSymbols = new Set(discovered.map((entry) => entry.symbol));
    const current = new Set(this.currentSymbols());

    const removed = [...current].filter((symbol) => !nextSymbols.has(symbol));
    const added = discovered
      .map((entry) => entry.symbol)
      .filter((symbol) => !current.has(symbol));

    if (removed.length > 0) {
      await this.removeSymbols(removed);
    }
    if (added.length > 0) {
      await this.distribute(added);
    }

    await this.deps.repository.setSymbols(this.currentSymbols());
    this.deps.logger.info(
      { removed: removed.length, added: added.length, connectors: this.connectors.length },
      'ребалансировка завершена',
    );
  }

  private discover() {
    return this.deps.discovery.discover(this.deps.config.filter.minQuoteVolumeUsdt);
  }

  private async removeSymbols(symbols: readonly string[]): Promise<void> {
    const byConnector = new Map<Connector, string[]>();
    for (const symbol of symbols) {
      const connector = this.symbolToConnector.get(symbol);
      if (!connector) {
        continue;
      }
      pushTo(byConnector, connector, symbol);
      this.symbolToConnector.delete(symbol);
    }

    for (const [connector, list] of byConnector) {
      await connector.removeSymbols(list);
    }
    await this.dropEmptyConnectors();
  }

  /** Распределить новые символы: сначала в коннекторы со свободными слотами. */
  private async distribute(symbols: readonly string[]): Promise<void> {
    const plan = new Map<Connector, string[]>();
    const fresh = new Set<Connector>();

    for (const symbol of symbols) {
      let target = this.connectors.find((connector) => this.slotsLeft(connector, plan) > 0);
      if (!target) {
        target = this.createConnector();
        this.connectors.push(target);
        fresh.add(target);
      }
      pushTo(plan, target, symbol);
      this.symbolToConnector.set(symbol, target);
    }

    for (const [connector, list] of plan) {
      if (fresh.has(connector)) {
        await connector.start(list);
      } else {
        await connector.addSymbols(list);
      }
    }
  }

  private slotsLeft(connector: Connector, plan: Map<Connector, string[]>): number {
    return connector.availableSlots - (plan.get(connector)?.length ?? 0);
  }

  private async dropEmptyConnectors(): Promise<void> {
    const empty = this.connectors.filter((connector) => connector.size === 0);
    for (const connector of empty) {
      await connector.stop();
    }
    if (empty.length > 0) {
      this.connectors.splice(
        0,
        this.connectors.length,
        ...this.connectors.filter((connector) => connector.size > 0),
      );
    }
  }

  private createConnector(): Connector {
    this.connectorSeq += 1;
    return new Connector(`conn-${this.connectorSeq}`, {
      rest: this.deps.rest,
      repository: this.deps.repository,
      logger: this.deps.logger,
      wsBaseUrl: this.deps.config.ws.baseUrl,
      wsStaleTimeoutMs: this.deps.config.ws.staleTimeoutMs,
      timeframes: this.deps.config.connector.timeframes,
      snapshotDepth: this.deps.config.connector.snapshotDepth,
      capacity: this.deps.config.connector.symbolsPerConnector,
      flushMs: this.deps.config.intervals.flushMs,
    });
  }

  private currentSymbols(): string[] {
    return [...this.symbolToConnector.keys()];
  }

  private scheduleRefresh(): void {
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) =>
        this.deps.logger.error({ err: error }, 'ошибка ребалансировки'),
      );
    }, this.deps.config.intervals.refreshMs);
  }
}

function pushTo<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

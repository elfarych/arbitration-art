/** Сборка зависимостей и жизненный цикл сервиса. */

import type { Redis } from 'ioredis';

import { BinanceRestClient } from '../binance/rest-client';
import { ConnectorManager } from './connector-manager';
import { SymbolDiscovery } from '../binance/symbol-discovery';
import { WeightRateLimiter } from '../binance/rate-limiter';
import { CandleRepository } from '../redis/candle-repository';
import { createRedis } from '../redis/redis-client';
import type { Config } from '../config/env';
import type { Logger } from '../utils/logger';

export class Application {
  private readonly redis: Redis;
  private readonly manager: ConnectorManager;
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    const limiter = new WeightRateLimiter(config.rest.weightLimitPerMin);
    const rest = new BinanceRestClient(config.rest.baseUrl, limiter);
    this.redis = createRedis(config.redis.url, logger);

    this.manager = new ConnectorManager({
      discovery: new SymbolDiscovery(rest),
      rest,
      repository: new CandleRepository(this.redis, config.redis.keyPrefix),
      config,
      logger,
    });
  }

  async start(): Promise<void> {
    this.registerShutdownHooks();
    await this.manager.start();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.logger.info('остановка сервиса…');
    await this.manager.stop();
    await this.redis.quit();
    this.logger.info('сервис остановлен');
  }

  private registerShutdownHooks(): void {
    const shutdown = (signal: string): void => {
      this.logger.info({ signal }, 'получен сигнал завершения');
      this.stop()
        .then(() => process.exit(0))
        .catch((error) => {
          this.logger.error({ err: error }, 'ошибка при остановке');
          process.exit(1);
        });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}

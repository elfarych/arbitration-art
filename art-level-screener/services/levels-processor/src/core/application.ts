/** Сборка зависимостей и цикл обработки с защитой от наложения проходов. */

import type { Redis } from 'ioredis';

import { CandleSource } from '../redis/candle-source';
import { LevelsRepository } from '../redis/levels-repository';
import { Processor } from './processor';
import { createRedis } from '../redis/redis-client';
import type { Config } from '../config/env';
import type { Logger } from '../utils/logger';

export class Application {
  private readonly redis: Redis;
  private readonly processor: Processor;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.redis = createRedis(config.redis.url, logger);
    const source = new CandleSource(this.redis, config.redis.sourcePrefix);
    const repository = new LevelsRepository(
      this.redis,
      config.redis.outputPrefix,
      config.redis.outputTtlMs,
    );
    this.processor = new Processor(source, repository, config, logger);
  }

  async start(): Promise<void> {
    this.registerShutdownHooks();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    this.logger.info({ intervalMs: this.config.intervalMs }, 'процессор запущен');
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.redis.quit();
    this.logger.info('процессор остановлен');
  }

  /** Один проход с защитой от наложения: если предыдущий ещё идёт — пропуск. */
  private async tick(): Promise<void> {
    if (this.running || this.stopping) {
      return;
    }
    this.running = true;
    try {
      await this.processor.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'ошибка прохода обработки');
    } finally {
      this.running = false;
    }
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

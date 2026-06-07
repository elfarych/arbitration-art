/** Dependency wiring and the 10s tick loop with overlap guard (mirrors
 * levels-processor's Application). */

import type { Redis } from 'ioredis';

import { CandleSource } from '../redis/candle-source';
import { createRedis } from '../redis/redis-client';
import { DjangoClient } from '../services/django-client';
import { NotifyStateStore } from '../state/notify-state';
import { Notifier } from './notifier';
import { TelegramClient } from '../telegram/telegram-client';
import { TelegramCommandListener } from '../telegram/command-listener';
import type { Config } from '../config/env';
import type { Logger } from '../utils/logger';

export class Application {
  private readonly redis: Redis;
  private readonly notifier: Notifier;
  private readonly commandListener: TelegramCommandListener;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.redis = createRedis(config.redis.url, logger);
    const source = new CandleSource(this.redis, config.redis.sourcePrefix);
    const django = new DjangoClient(config.django.apiUrl, config.django.serviceToken, logger);
    const telegram = new TelegramClient(config.telegram.botToken, logger);
    const state = new NotifyStateStore(this.redis, config.cooldownMs);
    this.notifier = new Notifier(config, source, django, state, telegram, logger);
    // Inbound half of the bot: answers /start with the user's chat_id (long polling).
    this.commandListener = new TelegramCommandListener(telegram, this.redis, logger);
  }

  async start(): Promise<void> {
    this.registerShutdownHooks();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
    await this.commandListener.start();
    this.logger.info({ intervalMs: this.config.intervalMs }, 'level-notifier started');
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.commandListener.stop();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.redis.quit();
    this.logger.info('level-notifier stopped');
  }

  /** One pass with overlap protection: if the previous one is still running — skip. */
  private async tick(): Promise<void> {
    if (this.running || this.stopping) {
      return;
    }
    this.running = true;
    try {
      await this.notifier.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'notifier tick failed');
    } finally {
      this.running = false;
    }
  }

  private registerShutdownHooks(): void {
    const shutdown = (signal: string): void => {
      this.logger.info({ signal }, 'shutdown signal received');
      this.stop()
        .then(() => process.exit(0))
        .catch((error) => {
          this.logger.error({ err: error }, 'error during shutdown');
          process.exit(1);
        });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}

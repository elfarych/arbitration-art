/** Тонкая обёртка над ioredis с логированием и graceful-закрытием. */

import Redis from 'ioredis';

import type { Logger } from '../utils/logger';

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  redis.on('error', (error) => logger.error({ err: error }, 'Redis ошибка'));
  redis.on('connect', () => logger.info('Redis подключён'));
  return redis;
}

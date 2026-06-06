/** Тонкая обёртка над ioredis с логированием. */

import Redis from 'ioredis';

import type { Logger } from '../utils/logger';

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  redis.on('error', (error) => logger.error({ err: error }, 'Redis ошибка'));
  redis.on('connect', () => logger.info('Redis подключён'));
  return redis;
}

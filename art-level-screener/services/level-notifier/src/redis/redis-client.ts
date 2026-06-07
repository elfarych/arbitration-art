/** Thin ioredis wrapper with logging (mirrors levels-processor). */

import Redis from 'ioredis';

import type { Logger } from '../utils/logger';

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  redis.on('error', (error) => logger.error({ err: error }, 'Redis error'));
  redis.on('connect', () => logger.info('Redis connected'));
  return redis;
}

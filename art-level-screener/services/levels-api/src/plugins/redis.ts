/** Плагин: подключение к Redis и декоратор `levels` (reader). */

import Redis from 'ioredis';
import fp from 'fastify-plugin';

import { LevelsReader } from '../redis/levels-reader';
import { CandleSource } from '../redis/candle-source';

export default fp(
  async (app) => {
    const redis = new Redis(app.config.redis.url, { maxRetriesPerRequest: null });
    redis.on('error', (error) => app.log.error({ err: error }, 'Redis ошибка'));

    app.decorate('levels', new LevelsReader(redis, app.config.redis.prefix));
    app.decorate('candles', new CandleSource(redis, app.config.redis.sourcePrefix));
    app.addHook('onClose', async () => {
      await redis.quit();
    });
  },
  { name: 'redis' },
);

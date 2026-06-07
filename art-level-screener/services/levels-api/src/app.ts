/** Сборка Fastify-приложения: плагины, общие схемы, маршруты. */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { SHARED_MODELS } from './schemas/level';
import { healthRoutes } from './routes/health';
import { screenerRoutes } from './routes/screener';
import { timeframesRoutes } from './routes/timeframes';
import { configRoutes } from './routes/config';
import { analysisRoutes } from './routes/analysis';
import redisPlugin from './plugins/redis';
import binancePlugin from './plugins/binance';
import swaggerPlugin from './plugins/swagger';
import type { Config } from './config/env';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('config', config);

  for (const model of SHARED_MODELS) {
    app.addSchema(model);
  }

  await app.register(cors, { origin: config.cors.origin });
  await app.register(swaggerPlugin);
  await app.register(redisPlugin);
  await app.register(binancePlugin);

  await app.register(healthRoutes);
  await app.register(timeframesRoutes);
  await app.register(configRoutes);
  await app.register(screenerRoutes);
  await app.register(analysisRoutes);

  return app;
}

/** Маршрут health-проверки. */

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

import { HealthResponse } from '../schemas/level';

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: 'Статус сервиса и Redis',
        response: { 200: HealthResponse },
      },
    },
    async () => {
      const redisUp = await app.levels.ping();
      return { status: 'ok' as const, redis: redisUp ? ('up' as const) : ('down' as const) };
    },
  );
};

/** Маршрут списка доступных таймфреймов. */

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

import { TimeframesResponse } from '../schemas/level';

export const timeframesRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/timeframes',
    {
      schema: {
        tags: ['meta'],
        summary: 'Список поддерживаемых таймфреймов (из конфигурации API)',
        response: { 200: TimeframesResponse },
      },
    },
    async () => app.config.timeframes,
  );
};

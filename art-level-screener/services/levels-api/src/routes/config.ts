/** Route: calculation parameters for the client-side analysis.

The frontend computes breakout analyses in the browser (fetching candles and
trades from Binance directly) and must use the SAME level-detection parameters as
the screener, otherwise it would find different levels. This endpoint exposes the
authoritative env defaults so the client never hardcodes them. */

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

import { ConfigResponse } from '../schemas/level';

export const configRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/config',
    {
      schema: {
        tags: ['meta'],
        summary: 'Параметры расчёта уровней/анализа для клиентского расчёта анализа',
        response: { 200: ConfigResponse },
      },
    },
    async () => ({
      levels: app.config.levels,
      analysis: app.config.analysis,
      binance: {
        restUrl: app.config.binance.restUrl,
        weightLimitPerMin: app.config.binance.weightLimitPerMin,
      },
    }),
  );
};

/** Маршруты скринера: экран по таймфрейму и детали по монете. */

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

import { applyScreenerQuery } from '../lib/screener-query';
import { computeScreener, resolveLevelParams } from '../lib/screener-compute';
import {
  ErrorResponse,
  ScreenerQuery,
  ScreenerResponse,
  SymbolDetail,
  SymbolParams,
  TimeframeParams,
} from '../schemas/level';

export const screenerRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/screener/:tf',
    {
      schema: {
        tags: ['screener'],
        summary: 'Экран скринера по таймфрейму (расчёт по запросу: minVolume/natrMultiplier/minGap + фильтры/сортировка/пагинация)',
        params: TimeframeParams,
        querystring: ScreenerQuery,
        response: { 200: ScreenerResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const params = resolveLevelParams(app.config.levels, request.query);
      const entries = await computeScreener(app.candles, {
        timeframe: request.params.tf,
        params,
        minVolume: request.query.minVolume,
        volume: app.config.volume,
        now: Date.now(),
      });
      if (entries === null) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: `Нет данных для таймфрейма ${request.params.tf}` });
      }
      const { total, items } = applyScreenerQuery(entries, request.query);
      return { timeframe: request.params.tf, total, count: items.length, items };
    },
  );

  app.get(
    '/screener/:tf/:symbol',
    {
      schema: {
        tags: ['screener'],
        summary: 'Полные уровни по монете и таймфрейму',
        params: SymbolParams,
        response: { 200: SymbolDetail, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const detail = await app.levels.getDetail(
        request.params.tf,
        request.params.symbol.toUpperCase(),
      );
      if (!detail) {
        return reply.code(404).send({
          error: 'not_found',
          message: `Нет данных для ${request.params.symbol} (${request.params.tf})`,
        });
      }
      return detail;
    },
  );
};

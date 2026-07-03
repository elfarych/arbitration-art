/** Route: breakout analysis for one coin (`GET /analysis/:tf/:symbol`).

Loads candles and trades from Binance directly (not Redis) so an arbitrary
candle count is honored, detects levels with the same code as the screener, and
verifies each level's first breakout against the request parameters. */

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

import { computeAnalysis } from '../lib/analysis-compute';
import { BinanceHttpError } from '../binance/rest-client';
import { AnalysisQuery, AnalysisResponse, ErrorResponse, SymbolParams } from '../schemas/level';

export const analysisRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/analysis/:tf/:symbol',
    {
      schema: {
        tags: ['analysis'],
        summary:
          'Анализ пробоев уровней по монете: уровни (как в скринере) → пробои слева направо → проверка по трейдам',
        params: SymbolParams,
        querystring: AnalysisQuery,
        response: { 200: AnalysisResponse, 404: ErrorResponse, 502: ErrorResponse },
      },
    },
    async (request, reply) => {
      const candles = request.query.candles ?? app.config.analysis.defaultCandles;
      try {
        const result = await computeAnalysis(
          app.binance,
          {
            timeframe: request.params.tf,
            symbol: request.params.symbol.toUpperCase(),
            natrMultiplier: request.query.natrMultiplier ?? app.config.levels.natrMultiplier,
            // Direct %-of-price tolerance overrides natrMultiplier when > 0.
            tolerancePct: request.query.tolerancePct,
            minGap: request.query.minGap ?? app.config.levels.minGap,
            direction: request.query.direction ?? 'both',
            maxBreakoutSeconds: request.query.maxBreakoutSeconds ?? 300,
            minMovePct: request.query.minMovePct ?? 0.5,
            candles,
          },
          {
            levels: app.config.levels,
            aggTradesLimit: app.config.analysis.aggTradesLimit,
            maxTradePages: app.config.analysis.maxTradePages,
          },
        );
        if (result === null) {
          return reply.code(404).send({
            error: 'not_found',
            message: `Недостаточно свечей для анализа ${request.params.symbol} (${request.params.tf})`,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof BinanceHttpError) {
          // Bad symbol / interval — Binance answers 4xx; surface as not found.
          if (error.statusCode >= 400 && error.statusCode < 500) {
            return reply.code(404).send({
              error: 'not_found',
              message: `Binance отклонил запрос для ${request.params.symbol} (${request.params.tf})`,
            });
          }
          app.log.error({ err: error }, 'Binance upstream error');
          return reply
            .code(502)
            .send({ error: 'upstream_error', message: 'Ошибка обращения к Binance' });
        }
        throw error;
      }
    },
  );
};

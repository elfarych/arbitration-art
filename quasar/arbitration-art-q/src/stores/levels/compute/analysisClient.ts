/** Frontend-only orchestrator for the client-side breakout analysis.

NOT mirrored from levels-api — this is the browser entry point that wires the
ported algorithm to a direct Binance client and the levels-api `/config` params.
The heavy work (fetching aggTrades per breakout) runs here, on the user's own IP,
so the Binance weight budget is distributed across users instead of the server. */

import type { AnalysisResult, LevelsConfig } from '../api/levelsApi';
import type { AnalysisSettings } from '../analysis.store';
import { BinanceRestClient } from './binance/rest-client';
import { WeightRateLimiter } from './binance/rate-limiter';
import { computeAnalysis } from './analysis-compute';

/**
 * Run a breakout analysis entirely in the browser and return the AnalysisResult
 * to POST to Django for persistence. Fetches candles + trades from Binance
 * directly (no proxy). Throws on too-few candles or Binance HTTP errors.
 *
 * `config` comes from levels-api `GET /config` so the level-detection params are
 * identical to the screener (otherwise the analysis would find different levels).
 */
export async function runClientAnalysis(
  symbol: string,
  settings: AnalysisSettings,
  config: LevelsConfig,
): Promise<AnalysisResult> {
  const limiter = new WeightRateLimiter(config.binance.weightLimitPerMin);
  const client = new BinanceRestClient(config.binance.restUrl, limiter);
  // Same cap levels-api applies server-side (ANALYSIS_MAX_CANDLES).
  const candles = Math.min(settings.candles, config.analysis.maxCandles);
  const result = await computeAnalysis(
    client,
    {
      timeframe: settings.timeframe,
      symbol: symbol.toUpperCase(),
      natrMultiplier: settings.natrMultiplier,
      // Percent mode pins the zone width directly; NATR mode leaves it undefined
      // so computeAnalysis derives the band from natr × natrMultiplier.
      tolerancePct: settings.toleranceMode === 'pct' ? settings.tolerancePct : undefined,
      minGap: settings.minGap,
      direction: settings.direction,
      maxBreakoutSeconds: settings.maxBreakoutSeconds,
      minMovePct: settings.minMovePct,
      candles,
    },
    {
      levels: config.levels,
      aggTradesLimit: config.analysis.aggTradesLimit,
      maxTradePages: config.analysis.maxTradePages,
    },
  );
  if (result === null) {
    throw new Error('Недостаточно свечей для анализа на этом таймфрейме');
  }
  return result;
}

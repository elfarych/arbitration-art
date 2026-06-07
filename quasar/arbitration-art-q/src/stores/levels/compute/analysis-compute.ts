/** On-demand breakout analysis: load candles → find levels (same detection code
 * as the screener) → scan left-to-right for each level's first breakout → verify
 * the breakout against the requested parameters using aggregated trades.

MIRROR of art-level-screener/services/levels-api/src/lib/analysis-compute.ts —
keep in sync (see ./README.md). The algorithm body is identical; the ONLY
divergences are the import paths and that the output types come from the
frontend wire types (`AnalysisResult`/`AnalysisBreakout` in ../api/levelsApi)
instead of the levels-api TypeBox statics. Both describe the same contract. */

import type { AnalysisResult, AnalysisBreakout } from '../api/levelsApi';
import type { BinanceRestClient } from './binance/rest-client';
import type { Candle, LevelKind, LevelParams } from './levels/types';
import { computeNatr } from './levels/natr';
import { countTouches } from './levels/touches';
import { findExtrema } from './levels/extrema';

export type BreakoutDirection = 'up' | 'down' | 'both';

/** Binance aggTrades requires the [startTime, endTime] window under one hour.
 * Historical depth is not limited — startTime/endTime returns old trades too. */
const AGG_TRADES_MAX_WINDOW_MS = 60 * 60 * 1000 - 1;

export interface AnalysisParams {
  timeframe: string;
  symbol: string;
  /** Touch/breakout zone width in NATR units (band % = natr·natrMultiplier). */
  natrMultiplier: number;
  /** Minimum candle gap between counted touches. */
  minGap: number;
  direction: BreakoutDirection;
  maxBreakoutSeconds: number;
  minMovePct: number;
  /** Number of candles to load and scan. */
  candles: number;
}

export interface AnalysisConfig {
  /** Env-level defaults: period, extremaWindow, minTouches, atrPeriod. */
  levels: LevelParams;
  aggTradesLimit: number;
  maxTradePages: number;
}

/** A level whose first breakout was located in the window (pre-trade check). */
interface BreakoutCandidate {
  price: number;
  levelTime: number;
  kind: LevelKind;
  direction: 'up' | 'down';
  touches: number;
  breakoutCandleTime: number;
}

/**
 * Run the breakout analysis for one symbol×timeframe.
 *
 * Returns `null` when there are not enough candles to detect any level. Binance
 * HTTP errors propagate to the caller.
 */
export async function computeAnalysis(
  client: BinanceRestClient,
  params: AnalysisParams,
  config: AnalysisConfig,
): Promise<AnalysisResult | null> {
  const candles = await client.klinesHistory(params.symbol, params.timeframe, params.candles);
  // Need the extrema window plus the right-edge cutoff, plus at least one bar to
  // the right for a breakout to exist.
  if (candles.length < config.levels.period + config.levels.extremaWindow + 2) {
    return null;
  }

  const levelParams: LevelParams = {
    ...config.levels,
    natrMultiplier: params.natrMultiplier,
    minGap: params.minGap,
  };
  const natr = computeNatr(candles, levelParams.atrPeriod);
  const tolerancePct = natr * levelParams.natrMultiplier;

  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const closes = candles.map((candle) => candle.close);

  const candidates: BreakoutCandidate[] = [];
  collectBreakouts(highs, closes, candles, 'top', levelParams, tolerancePct, candidates);
  collectBreakouts(lows, closes, candles, 'bottom', levelParams, tolerancePct, candidates);

  const selected = candidates
    .filter((c) => params.direction === 'both' || c.direction === params.direction)
    .sort((a, b) => a.breakoutCandleTime - b.breakoutCandleTime);

  // A cluster of nearby extrema produces several levels at the same price that
  // all break on (nearly) the same candle — collapse those duplicates into one.
  const dedupGapMs = levelParams.maxBrokenAge * timeframeMs(params.timeframe);
  const unique = dedupeBreakouts(selected, tolerancePct, dedupGapMs);

  const breakouts: AnalysisBreakout[] = [];
  for (const candidate of unique) {
    breakouts.push(await verifyWithTrades(client, params, candidate, config));
  }

  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    params: {
      natrMultiplier: params.natrMultiplier,
      minGap: params.minGap,
      direction: params.direction,
      maxBreakoutSeconds: params.maxBreakoutSeconds,
      minMovePct: params.minMovePct,
      candles: candles.length,
    },
    candlesAnalyzed: candles.length,
    range: { from: candles[0].openTime, to: candles[candles.length - 1].openTime },
    summary: buildSummary(breakouts),
    breakouts,
  };
}

/**
 * Find every valid level on one side and its first breakout.
 *
 * A level is a significant extremum (same `findExtrema` as the screener) that,
 * before being breached, was touched at least `minTouches` times within the NATR
 * tolerance band (same `countTouches`). Its breakout is the first candle that
 * **closes** beyond the level (top → close above, bottom → close below). Using
 * the close (not the high/low wick) filters out wick fakeouts — a single tick
 * poking through the level that closes back inside is not a breakout. Levels
 * never breached in the window produce no breakout event.
 */
function collectBreakouts(
  series: readonly number[],
  closes: readonly number[],
  candles: readonly Candle[],
  kind: LevelKind,
  params: LevelParams,
  tolerancePct: number,
  out: BreakoutCandidate[],
): void {
  const isTop = kind === 'top';
  const extrema = findExtrema(series, params.period, !isTop, params.extremaWindow);

  for (const index of extrema) {
    const level = series[index];
    const breakoutIndex = firstBreachIndex(closes, index + 1, level, isTop);
    if (breakoutIndex === -1) {
      continue; // never closed beyond the level inside the window
    }
    // Touches are counted on the wick series (highs/lows) only between formation
    // and the breakout — the level must be established before it breaks.
    // previousInside=true suppresses the residual in-band candles after the extremum.
    const beforeBreak = series.slice(index + 1, breakoutIndex);
    const touches = countTouches(level, beforeBreak, tolerancePct, params.minGap, true);
    if (touches < params.minTouches) {
      continue;
    }
    out.push({
      price: level,
      levelTime: candles[index].openTime,
      kind,
      direction: isTop ? 'up' : 'down',
      touches,
      breakoutCandleTime: candles[breakoutIndex].openTime,
    });
  }
}

/** Index of the first value strictly beyond the level from `start`, or -1. */
function firstBreachIndex(
  series: readonly number[],
  start: number,
  level: number,
  isTop: boolean,
): number {
  for (let i = start; i < series.length; i++) {
    if (isTop ? series[i] > level : series[i] < level) {
      return i;
    }
  }
  return -1;
}

/**
 * Collapse duplicate breakouts of the same level. Several nearby extrema form
 * levels at the same price that all break on (nearly) the same candle; these are
 * one event. Candidates (sorted by breakout time) are merged when same-side,
 * price within the tolerance band, and breakout candles within `gapMs`. The
 * earliest is kept (its time/price), with the cluster's max touch count.
 */
function dedupeBreakouts(
  candidates: readonly BreakoutCandidate[],
  tolerancePct: number,
  gapMs: number,
): BreakoutCandidate[] {
  const kept: BreakoutCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = kept.find(
      (k) =>
        k.direction === candidate.direction &&
        withinBand(k.price, candidate.price, tolerancePct) &&
        candidate.breakoutCandleTime - k.breakoutCandleTime <= gapMs,
    );
    if (duplicate) {
      if (candidate.touches > duplicate.touches) {
        duplicate.touches = candidate.touches; // show the strongest level's touches
      }
      continue;
    }
    kept.push({ ...candidate });
  }
  return kept;
}

/** Whether two prices are within `tolerancePct` % of each other (same level zone). */
function withinBand(a: number, b: number, tolerancePct: number): boolean {
  if (a === 0) {
    return a === b;
  }
  return (Math.abs(a - b) / a) * 100 <= tolerancePct;
}

/**
 * Confirm a breakout against the parameters using aggregated trades, in two
 * phases over time-ascending trades.
 *
 * Phase 1 — find the cross: the breach happens somewhere INSIDE the breakout
 * candle, not at its open, so trades are scanned across the whole breakout candle
 * `[openTime, openTime + tf]` for the first trade strictly beyond the LEVEL on
 * the breakout side (`crossTime`). The level itself is used (not the touch-zone
 * band — that band, `natrMultiplier`, is for level detection only), so every
 * breakout that the candle confirmed also has a trade cross.
 *
 * Phase 2 — measure from the cross: within `[crossTime, crossTime +
 * maxBreakoutSeconds]` the PEAK move beyond the level is tracked (`movePct`, with
 * `peakTime`) and the first trade reaching `minMovePct` is `reachTime`. So every
 * crossed breakout reports its move and time-to-peak, not just matches. Match =
 * peak reached `minMovePct` (`reachTime` set). Each aggTrades request is capped
 * to Binance's <1h window; pagination advances by time up to the deadline.
 */
async function verifyWithTrades(
  client: BinanceRestClient,
  params: AnalysisParams,
  candidate: BreakoutCandidate,
  config: AnalysisConfig,
): Promise<AnalysisBreakout> {
  const maxMs = params.maxBreakoutSeconds * 1000;
  const tfMs = timeframeMs(params.timeframe);

  const isUp = candidate.direction === 'up';
  const level = candidate.price;
  const targetPrice = isUp
    ? level * (1 + params.minMovePct / 100)
    : level * (1 - params.minMovePct / 100);

  let crossTime: number | null = null;
  let reachTime: number | null = null;
  let peakMovePct = 0;
  let peakTime: number | null = null;
  let tradesSeen = 0;

  let cursor = candidate.breakoutCandleTime;
  // Deadline for finding the cross is the breakout candle; once crossed it
  // becomes crossTime + maxMs (the post-breakout move window).
  let deadline = candidate.breakoutCandleTime + tfMs;

  for (let page = 0; page < config.maxTradePages; page++) {
    const reqEnd = Math.min(cursor + AGG_TRADES_MAX_WINDOW_MS, deadline);
    if (reqEnd <= cursor) {
      break;
    }
    const trades = await client.aggTrades(params.symbol, cursor, reqEnd, config.aggTradesLimit);
    if (trades.length === 0) {
      if (reqEnd >= deadline) {
        break;
      }
      cursor = reqEnd + 1; // sparse sub-window with no trades — keep scanning
      continue;
    }
    let pastDeadline = false;
    for (const trade of trades) {
      tradesSeen += 1;
      if (crossTime === null) {
        if (isUp ? trade.price > level : trade.price < level) {
          crossTime = trade.time;
          deadline = crossTime + maxMs; // measure the move window from the cross
        } else {
          continue; // before the cross: nothing to measure yet
        }
      }
      if (trade.time > deadline) {
        pastDeadline = true;
        break; // past the post-cross window — scan no further
      }
      const movePct = isUp
        ? ((trade.price - level) / level) * 100
        : ((level - trade.price) / level) * 100;
      if (movePct > peakMovePct) {
        peakMovePct = movePct;
        peakTime = trade.time;
      }
      // First trade reaching the target marks the match; keep scanning the rest
      // of the window so movePct/peakTime reflect the true peak.
      if (reachTime === null && (isUp ? trade.price >= targetPrice : trade.price <= targetPrice)) {
        reachTime = trade.time;
      }
    }
    if (pastDeadline) {
      break;
    }
    const last = trades[trades.length - 1];
    if (last.time >= deadline) {
      break;
    }
    if (trades.length < config.aggTradesLimit && reqEnd >= deadline) {
      break; // window fully scanned and exhausted
    }
    cursor = last.time + 1;
  }

  const matched = reachTime !== null;
  const elapsedMs = crossTime !== null && peakTime !== null ? peakTime - crossTime : null;

  return {
    price: candidate.price,
    levelTime: candidate.levelTime,
    kind: candidate.kind,
    direction: candidate.direction,
    touches: candidate.touches,
    breakoutCandleTime: candidate.breakoutCandleTime,
    crossTime,
    reachTime,
    elapsedMs,
    movePct: crossTime !== null ? peakMovePct : null,
    matched,
    reason: matchReason(tradesSeen, crossTime, reachTime, matched),
  };
}

/** Timeframe string ("5m", "1h", "1d", "1w") to milliseconds; fallback 1m. */
function timeframeMs(tf: string): number {
  const match = /^(\d+)([mhdw])$/.exec(tf);
  if (!match) {
    return 60_000;
  }
  const n = Number(match[1]);
  const unitMs =
    match[2] === 'm'
      ? 60_000
      : match[2] === 'h'
        ? 3_600_000
        : match[2] === 'd'
          ? 86_400_000
          : 604_800_000;
  return n * unitMs;
}

function matchReason(
  tradesSeen: number,
  crossTime: number | null,
  reachTime: number | null,
  matched: boolean,
): string {
  if (tradesSeen === 0) return 'no_trades';
  if (crossTime === null) return 'no_cross';
  if (reachTime === null) return 'min_move_not_reached';
  return matched ? 'ok' : 'too_slow';
}

/** Breakouts excluded from the match rate: no trades in the window to check. */
function isEvaluated(breakout: AnalysisBreakout): boolean {
  return breakout.reason !== 'no_trades';
}

function buildSummary(breakouts: readonly AnalysisBreakout[]): AnalysisResult['summary'] {
  const matched = breakouts.filter((b) => b.matched).length;
  const evaluated = breakouts.filter(isEvaluated).length;
  const up = breakouts.filter((b) => b.direction === 'up');
  const down = breakouts.filter((b) => b.direction === 'down');
  return {
    breakoutsFound: breakouts.length,
    evaluated,
    matched,
    unmatched: evaluated - matched,
    matchRate: evaluated > 0 ? matched / evaluated : 0,
    byDirection: {
      up: { found: up.length, matched: up.filter((b) => b.matched).length },
      down: { found: down.length, matched: down.filter((b) => b.matched).length },
    },
  };
}

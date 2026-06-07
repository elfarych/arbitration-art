/** On-demand screener computation: read raw candles → optional volume
 * pre-filter → calculate levels for survivors → ScreenerEntry[].

Adapted copy of `levels-api/src/lib/screener-compute.ts`. Identical math; the
only change is the return type uses the local `ScreenerEntry` (levels/types)
instead of the levels-api TypeBox schema, so the notifier has no Fastify/TypeBox
dependency. Keep the algorithm in sync with levels-api (source of truth). */

import type { CandleSource } from '../redis/candle-source';
import type { Candle, LevelParams, ScreenerEntry } from '../levels/types';
import { calculateHorizontalLevels } from '../levels/horizontal-levels';
import { buildLevelViews } from '../levels/level-view';

/** Source timeframe and lookback for the USDT-volume pre-filter. */
export interface VolumeConfig {
  timeframe: string;
  lookback: number;
}

export interface ComputeOptions {
  timeframe: string;
  params: LevelParams;
  /** Minimum USDT turnover; when undefined or <= 0 the volume filter is off. */
  minVolume: number | undefined;
  volume: VolumeConfig;
  /** Calculation timestamp (ms, Unix) stamped onto every entry. */
  now: number;
}

/** Build effective level params: per-config overrides win, env defaults fill the rest. */
export function resolveLevelParams(
  defaults: LevelParams,
  overrides: { natrMultiplier?: number; minGap?: number },
): LevelParams {
  return {
    ...defaults,
    natrMultiplier: overrides.natrMultiplier ?? defaults.natrMultiplier,
    minGap: overrides.minGap ?? defaults.minGap,
  };
}

/**
 * USDT (quote) turnover over the last `lookback` candles.
 *
 * The connector stores base-asset `volume` only, so per-candle quote volume is
 * approximated as `volume · close`. Sums over the last `lookback` candles (fewer
 * if the series is shorter).
 */
export function quoteVolume(candles: readonly Candle[], lookback: number): number {
  const start = Math.max(0, candles.length - lookback);
  let sum = 0;
  for (let i = start; i < candles.length; i++) {
    sum += candles[i].volume * candles[i].close;
  }
  return sum;
}

/**
 * Compute the screen for a timeframe.
 *
 * Returns `null` when there is no source data to compute from (connector not
 * ready, or the timeframe has no candles at all). Returns `[]` when source data
 * exists but the volume filter excluded every coin. Entries are sorted by
 * proximity (`distanceNatr` ↑).
 */
export async function computeScreener(
  source: CandleSource,
  opts: ComputeOptions,
): Promise<ScreenerEntry[] | null> {
  const symbols = await source.getSymbols();
  if (symbols.length === 0) {
    return null;
  }

  const useVolumeFilter = opts.minVolume !== undefined && opts.minVolume > 0;
  let survivors = symbols;
  let volumeSeries: Map<string, Candle[]> | undefined;

  if (useVolumeFilter) {
    volumeSeries = await source.getSeries(symbols, opts.volume.timeframe);
    const threshold = opts.minVolume as number;
    survivors = symbols.filter((symbol) => {
      const candles = volumeSeries?.get(symbol);
      return candles ? quoteVolume(candles, opts.volume.lookback) >= threshold : false;
    });
  }
  if (survivors.length === 0) {
    return [];
  }

  // Reuse the volume series when the requested timeframe is the volume timeframe,
  // otherwise read the requested-timeframe series only for survivors.
  const series =
    volumeSeries && opts.timeframe === opts.volume.timeframe
      ? volumeSeries
      : await source.getSeries(survivors, opts.timeframe);
  if (series.size === 0) {
    return null; // timeframe has no source candles at all
  }

  const entries: ScreenerEntry[] = [];
  for (const symbol of survivors) {
    const candles = series.get(symbol);
    if (candles && isSufficient(candles, opts.params)) {
      entries.push(buildEntry(symbol, candles, opts.params, opts.now));
    }
  }
  entries.sort((a, b) => distanceKey(a) - distanceKey(b));
  return entries;
}

function buildEntry(
  symbol: string,
  candles: readonly Candle[],
  params: LevelParams,
  updatedAt: number,
): ScreenerEntry {
  const result = calculateHorizontalLevels(candles, params);
  const active = buildLevelViews(result.active, result.price, result.natr);
  const broken = buildLevelViews(result.broken, result.price, result.natr);
  return {
    symbol,
    price: result.price,
    natr: result.natr,
    levels: active,
    nearest: active[0] ?? null,
    activeCount: active.length,
    brokenCount: broken.length,
    updatedAt,
  };
}

/** Need enough candles for the extrema window plus the right-edge cutoff. */
function isSufficient(candles: readonly Candle[], params: LevelParams): boolean {
  return candles.length > params.period + params.extremaWindow;
}

/** Sort key: nearer by NATR first; coins without active levels go last. */
function distanceKey(entry: ScreenerEntry): number {
  return entry.nearest?.distanceNatr ?? Number.POSITIVE_INFINITY;
}

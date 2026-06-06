/** Загрузка конфигурации из переменных окружения (.env). */

import 'dotenv/config';

import type { LevelParams } from '../levels/types';

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  redis: {
    url: string;
    /** Prefix of pre-calculated levels (timeframes/health reader). */
    prefix: string;
    /** Prefix of raw connector candles — source for on-demand calculation. */
    sourcePrefix: string;
  };
  cors: {
    origin: string | string[];
  };
  /** Timeframes exposed by `/screener` and `/timeframes` — independent of the processor. */
  timeframes: string[];
  /** Default level parameters; per-request query params override a subset. */
  levels: LevelParams;
  /** USDT-volume pre-filter source (sum over `lookback` candles of `timeframe`). */
  volume: {
    timeframe: string;
    lookback: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parseNumber(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      prefix: env.LEVELS_PREFIX ?? 'levels',
      sourcePrefix: env.SOURCE_PREFIX ?? 'binance-futures',
    },
    cors: {
      origin: parseOrigin(env.CORS_ORIGIN ?? '*'),
    },
    timeframes: parseTimeframes(env.TIMEFRAMES ?? '1m,5m,15m,1h'),
    levels: {
      period: parseNumber(env.PERIOD, 40),
      extremaWindow: parseNumber(env.EXTREMA_WINDOW, 20),
      maxBrokenAge: parseNumber(env.MAX_BROKEN_AGE, 30),
      minTouches: parseNumber(env.MIN_TOUCHES, 2),
      minGap: parseNumber(env.MIN_GAP, 12),
      natrMultiplier: parseNumber(env.NATR_MULTIPLIER, 0.3),
      atrPeriod: parseNumber(env.ATR_PERIOD, 14),
    },
    volume: {
      timeframe: env.VOLUME_TIMEFRAME ?? '1h',
      lookback: parseNumber(env.VOLUME_LOOKBACK, 24),
    },
  };
}

function parseTimeframes(raw: string): string[] {
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (parsed.length === 0) {
    throw new Error('TIMEFRAMES не должен быть пустым');
  }
  return parsed;
}

function parseOrigin(raw: string): string | string[] {
  if (raw.trim() === '*') {
    return '*';
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Ожидалось число, получено: ${raw}`);
  }
  return value;
}

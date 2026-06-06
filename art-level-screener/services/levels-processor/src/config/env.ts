/** Загрузка и валидация конфигурации из переменных окружения (.env). */

import 'dotenv/config';

import type { LevelParams } from '../types/level';

export interface Config {
  redis: {
    url: string;
    sourcePrefix: string;
    outputPrefix: string;
    outputTtlMs: number;
  };
  timeframes: string[];
  intervalMs: number;
  levels: LevelParams;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      sourcePrefix: env.SOURCE_PREFIX ?? 'binance-futures',
      outputPrefix: env.OUTPUT_PREFIX ?? 'levels',
      outputTtlMs: parseNumber(env.OUTPUT_TTL_MS, 30_000),
    },
    timeframes: parseTimeframes(env.TIMEFRAMES ?? '1m,5m,15m,1h'),
    intervalMs: parseNumber(env.INTERVAL_MS, 10_000),
    levels: {
      period: parseNumber(env.PERIOD, 40),
      extremaWindow: parseNumber(env.EXTREMA_WINDOW, 20),
      maxBrokenAge: parseNumber(env.MAX_BROKEN_AGE, 30),
      minTouches: parseNumber(env.MIN_TOUCHES, 2),
      minGap: parseNumber(env.MIN_GAP, 12),
      natrMultiplier: parseNumber(env.NATR_MULTIPLIER, 0.3),
      atrPeriod: parseNumber(env.ATR_PERIOD, 14),
    },
    logLevel: env.LOG_LEVEL ?? 'info',
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

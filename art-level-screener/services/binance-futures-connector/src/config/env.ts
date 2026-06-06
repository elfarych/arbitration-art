/** Загрузка и валидация конфигурации из переменных окружения (.env). */

import 'dotenv/config';

import { BASE_TIMEFRAME, isTimeframe, type Timeframe } from '../aggregation/timeframe';

export interface Config {
  rest: {
    baseUrl: string;
    weightLimitPerMin: number;
  };
  ws: {
    baseUrl: string;
    staleTimeoutMs: number;
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  filter: {
    minQuoteVolumeUsdt: number;
  };
  connector: {
    symbolsPerConnector: number;
    snapshotDepth: number;
    timeframes: Timeframe[];
  };
  intervals: {
    flushMs: number;
    refreshMs: number;
  };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeframes = parseTimeframes(env.TIMEFRAMES ?? '1m,5m,15m,1h');

  return {
    rest: {
      baseUrl: env.BINANCE_FUTURES_REST_URL ?? 'https://fapi.binance.com',
      weightLimitPerMin: parseNumber(env.REST_WEIGHT_LIMIT_PER_MIN, 2400),
    },
    ws: {
      baseUrl: env.BINANCE_FUTURES_WS_URL ?? 'wss://fstream.binance.com',
      staleTimeoutMs: parseNumber(env.WS_STALE_TIMEOUT_MS, 30_000),
    },
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      keyPrefix: env.REDIS_KEY_PREFIX ?? 'binance-futures',
    },
    filter: {
      minQuoteVolumeUsdt: parseNumber(env.MIN_24H_VOLUME_USDT, 10_000),
    },
    connector: {
      symbolsPerConnector: parseNumber(env.SYMBOLS_PER_CONNECTOR, 20),
      snapshotDepth: parseNumber(env.SNAPSHOT_DEPTH, 1000),
      timeframes,
    },
    intervals: {
      flushMs: parseNumber(env.FLUSH_INTERVAL_MS, 3000),
      refreshMs: parseNumber(env.REFRESH_INTERVAL_MS, 3_600_000),
    },
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

function parseTimeframes(raw: string): Timeframe[] {
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const value of parsed) {
    if (!isTimeframe(value)) {
      throw new Error(`Неизвестный таймфрейм в TIMEFRAMES: ${value}`);
    }
  }

  const timeframes = parsed as Timeframe[];
  if (!timeframes.includes(BASE_TIMEFRAME)) {
    throw new Error(`TIMEFRAMES должен включать базовый '${BASE_TIMEFRAME}'`);
  }
  return timeframes;
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

/** Load and validate configuration from environment variables (.env). */

import 'dotenv/config';

import type { LevelParams } from '../levels/types';
import type { VolumeConfig } from '../lib/screener-compute';

export interface Config {
  redis: {
    url: string;
    /** Prefix of raw connector candles — must equal the connector REDIS_KEY_PREFIX. */
    sourcePrefix: string;
  };
  intervalMs: number;
  logLevel: string;
  django: {
    /** Base URL incl. `/api`, e.g. http://127.0.0.1:8000/api. */
    apiUrl: string;
    /** Shared service token — must equal Django SERVICE_SHARED_TOKEN. */
    serviceToken: string;
  };
  telegram: {
    botToken: string;
  };
  /** Frontend origin used to build the deep link, e.g. http://localhost:9000. */
  siteBaseUrl: string;
  /** Per (user, tf, symbol, level) anti-spam cooldown. */
  cooldownMs: number;
  /** Price-crossing alerts (independent of the level proximity pass). */
  price: {
    /** Master switch for the price-notification pass. */
    enabled: boolean;
    /** Skip a price whose `:updated:` is older than this — frozen feed guard. */
    maxStalenessMs: number;
  };
  /** USDT-volume pre-filter source — must match the screener (1h × 24). */
  volume: VolumeConfig;
  /** Default level parameters; per-config natrMultiplier/minGap override a subset. */
  levels: LevelParams;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    redis: {
      url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      sourcePrefix: env.SOURCE_PREFIX ?? 'binance-futures',
    },
    intervalMs: parseNumber(env.INTERVAL_MS, 10_000),
    logLevel: env.LOG_LEVEL ?? 'info',
    django: {
      apiUrl: stripTrailingSlash(requireString(env.DJANGO_API_URL, 'DJANGO_API_URL')),
      serviceToken: requireString(env.SERVICE_SHARED_TOKEN, 'SERVICE_SHARED_TOKEN'),
    },
    telegram: {
      botToken: requireString(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    },
    siteBaseUrl: stripTrailingSlash(requireString(env.SITE_BASE_URL, 'SITE_BASE_URL')),
    cooldownMs: parseNumber(env.NOTIFY_COOLDOWN_MS, 1_800_000),
    price: {
      enabled: parseBoolean(env.PRICE_NOTIFICATIONS_ENABLED, true),
      maxStalenessMs: parseNumber(env.PRICE_MAX_STALENESS_MS, 60_000),
    },
    volume: {
      timeframe: env.VOLUME_TIMEFRAME ?? '1h',
      lookback: parseNumber(env.VOLUME_LOOKBACK, 24),
    },
    levels: {
      period: parseNumber(env.PERIOD, 40),
      extremaWindow: parseNumber(env.EXTREMA_WINDOW, 20),
      maxBrokenAge: parseNumber(env.MAX_BROKEN_AGE, 30),
      minTouches: parseNumber(env.MIN_TOUCHES, 2),
      minGap: parseNumber(env.MIN_GAP, 12),
      natrMultiplier: parseNumber(env.NATR_MULTIPLIER, 0.3),
      atrPeriod: parseNumber(env.ATR_PERIOD, 14),
    },
  };
}

function requireString(raw: string | undefined, name: string): string {
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected a number, got: ${raw}`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

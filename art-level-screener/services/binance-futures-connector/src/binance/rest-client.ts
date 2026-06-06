/** REST-клиент Binance USDⓈ-M Futures поверх undici с учётом веса запросов. */

import { request } from 'undici';

import type { Timeframe } from '../aggregation/timeframe';
import type { Candle } from '../types/candle';
import type { ExchangeInfoResponse, KlineRow, Ticker24h } from '../types/binance';
import type { WeightRateLimiter } from './rate-limiter';

const USED_WEIGHT_HEADER = 'x-mbx-used-weight-1m';

export class BinanceHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`Binance HTTP ${statusCode}: ${body}`);
    this.name = 'BinanceHttpError';
  }
}

export class BinanceRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly limiter: WeightRateLimiter,
  ) {}

  exchangeInfo(): Promise<ExchangeInfoResponse> {
    return this.get<ExchangeInfoResponse>('/fapi/v1/exchangeInfo', {}, 1);
  }

  ticker24h(): Promise<Ticker24h[]> {
    return this.get<Ticker24h[]>('/fapi/v1/ticker/24hr', {}, 40);
  }

  async klines(symbol: string, interval: Timeframe, limit: number): Promise<Candle[]> {
    const rows = await this.get<KlineRow[]>(
      '/fapi/v1/klines',
      { symbol, interval, limit: String(limit) },
      klinesWeight(limit),
    );
    return rows.map(parseKlineRow);
  }

  private get<T>(path: string, query: Record<string, string>, weight: number): Promise<T> {
    return this.limiter.run(weight, async () => {
      const url = `${this.baseUrl}${path}${buildQuery(query)}`;
      const response = await request(url, { method: 'GET' });

      this.limiter.observe(Number(headerValue(response.headers[USED_WEIGHT_HEADER])));

      if (response.statusCode >= 400) {
        throw new BinanceHttpError(response.statusCode, await response.body.text());
      }
      return (await response.body.json()) as T;
    });
  }
}

/** Вес запроса klines в зависимости от глубины (правила Binance Futures). */
function klinesWeight(limit: number): number {
  if (limit <= 100) return 1;
  if (limit <= 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

function parseKlineRow(row: KlineRow): Candle {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function buildQuery(query: Record<string, string>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) {
    return '';
  }
  const params = new URLSearchParams(entries);
  return `?${params.toString()}`;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

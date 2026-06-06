/** Native Binance USDⓈ-M Futures REST client (undici) for breakout analysis.

Public market data only — no API keys, no signing (rule §5.2: native clients,
no ccxt). Provides candles (`/fapi/v1/klines`) and aggregated trades
(`/fapi/v1/aggTrades`). Requests are serialized and weight-limited via
`WeightRateLimiter`. The `Candle` shape matches the connector's Redis candles so
the same level-detection code in `../levels` consumes it unchanged. */

import { request } from 'undici';

import type { Candle } from '../levels/types';
import type { WeightRateLimiter } from './rate-limiter';

const USED_WEIGHT_HEADER = 'x-mbx-used-weight-1m';
const KLINES_MAX_LIMIT = 1500;
const AGG_TRADES_WEIGHT = 20;

/** One aggregated trade, normalized from the Binance row. */
export interface AggTrade {
  /** Trade price. */
  price: number;
  /** Trade quantity (base asset). */
  qty: number;
  /** Trade time (ms, Unix). */
  time: number;
  /** True when the buyer is the maker (i.e. an aggressive sell). */
  isBuyerMaker: boolean;
}

/** Binance klines row: [openTime, open, high, low, close, volume, closeTime, ...]. */
type KlineRow = [number, string, string, string, string, string, number, ...unknown[]];

/** Binance aggTrades row. */
interface AggTradeRow {
  p: string; // price
  q: string; // quantity
  T: number; // timestamp (ms)
  m: boolean; // is buyer the maker
}

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

  /**
   * One page of candles for a symbol×interval (Binance caps `limit` at 1500).
   *
   * Without `endTime` returns the latest `limit` candles; with `endTime` returns
   * up to `limit` candles ending at/just before it. Ascending by open time.
   */
  async klines(
    symbol: string,
    interval: string,
    limit: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const capped = Math.min(Math.max(1, Math.floor(limit)), KLINES_MAX_LIMIT);
    const query: Record<string, string> = { symbol, interval, limit: String(capped) };
    if (endTime !== undefined) {
      query.endTime = String(endTime);
    }
    const rows = await this.get<KlineRow[]>('/fapi/v1/klines', query, klinesWeight(capped));
    return rows.map(parseKlineRow);
  }

  /**
   * Latest `total` candles, paginating backwards when `total` exceeds the 1500
   * per-request cap. Pages are stitched oldest→newest; stops early if Binance
   * runs out of history. Returns ascending by open time.
   */
  async klinesHistory(symbol: string, interval: string, total: number): Promise<Candle[]> {
    const want = Math.max(1, Math.floor(total));
    let out: Candle[] = [];
    let endTime: number | undefined;
    while (out.length < want) {
      const limit = Math.min(KLINES_MAX_LIMIT, want - out.length);
      const page = await this.klines(symbol, interval, limit, endTime);
      if (page.length === 0) {
        break;
      }
      out = page.concat(out); // older page, ascending → prepend
      if (page.length < limit) {
        break; // history exhausted
      }
      endTime = page[0].openTime - 1; // next page ends strictly before the oldest
    }
    return out.length > want ? out.slice(out.length - want) : out;
  }

  /**
   * Aggregated trades in `[startTime, endTime]` (both inclusive, ms).
   *
   * Binance requires the window to be under 1 hour when both bounds are set; the
   * caller is responsible for capping it. Returns up to `limit` trades ordered by
   * time; paginate by advancing `startTime` past the last returned trade.
   */
  async aggTrades(
    symbol: string,
    startTime: number,
    endTime: number,
    limit: number,
  ): Promise<AggTrade[]> {
    const rows = await this.get<AggTradeRow[]>(
      '/fapi/v1/aggTrades',
      {
        symbol,
        startTime: String(startTime),
        endTime: String(endTime),
        limit: String(limit),
      },
      AGG_TRADES_WEIGHT,
    );
    return rows.map(parseAggTradeRow);
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

/** klines request weight by depth (Binance Futures rules). */
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

function parseAggTradeRow(row: AggTradeRow): AggTrade {
  return {
    price: Number(row.p),
    qty: Number(row.q),
    time: row.T,
    isBuyerMaker: row.m,
  };
}

function buildQuery(query: Record<string, string>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) {
    return '';
  }
  return `?${new URLSearchParams(entries).toString()}`;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

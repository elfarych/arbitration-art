/** Reading raw candles and the symbol list from Redis (written by the connector).

The connector stores the whole OHLCV series for each symbol×timeframe under a
single key `<sourcePrefix>:candles:<SYMBOL>:<tf>` and the active universe under
`<sourcePrefix>:symbols`. This reader is the source for on-demand level
calculation (the contract is the connector's Redis keys). Copy of
`levels-api/src/redis/candle-source.ts`. */

import type { Redis } from 'ioredis';

import type { Candle } from '../levels/types';

export class CandleSource {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  /** Active symbol universe; empty array if the connector has not populated it. */
  async getSymbols(): Promise<string[]> {
    const raw = await this.redis.get(`${this.prefix}:symbols`);
    if (!raw) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Load candle series for the given symbols at one timeframe with a single
   * `MGET`. Returns symbol → candles; symbols without data are omitted.
   */
  async getSeries(symbols: readonly string[], timeframe: string): Promise<Map<string, Candle[]>> {
    const map = new Map<string, Candle[]>();
    if (symbols.length === 0) {
      return map;
    }
    const keys = symbols.map((symbol) => this.candleKey(symbol, timeframe));
    const values = await this.redis.mget(keys);
    for (let i = 0; i < symbols.length; i++) {
      const candles = parseCandles(values[i]);
      if (candles) {
        map.set(symbols[i], candles);
      }
    }
    return map;
  }

  private candleKey(symbol: string, timeframe: string): string {
    return `${this.prefix}:candles:${symbol}:${timeframe}`;
  }
}

function parseCandles(raw: string | null): Candle[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Candle[]) : null;
  } catch {
    return null;
  }
}

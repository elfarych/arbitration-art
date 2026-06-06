import axios from 'axios';
import type { CandlestickData, UTCTimestamp } from 'lightweight-charts';

// Candles are visual context for the level charts; the horizontal levels
// themselves come from levels-api. Klines are pulled from Binance USDⓈ-M
// Futures through the dev proxy configured in quasar.config.ts
// (`/binance-api` -> https://fapi.binance.com), the same path the exchanges
// feature uses for browser-side Binance access.
const binanceHttp = axios.create({ baseURL: '/binance-api/fapi/v1' });

// symbol is already exchange-formatted (e.g. "BTCUSDT" from ScreenerEntry).
// interval matches the screener timeframe (1m/5m/15m/1h/...).
// endTime (ms) loads older history ending at that time — used to lazy-load bars
// when the user scrolls past the left edge of the loaded data.
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 300,
  endTime?: number,
): Promise<CandlestickData[]> {
  let url = `/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
  if (endTime !== undefined) url += `&endTime=${endTime}`;
  const { data } = await binanceHttp.get<(string | number)[][]>(url);
  return data.map((k) => ({
    // Binance openTime is in ms; lightweight-charts expects UTCTimestamp in s.
    time: Math.floor((k[0] as number) / 1000) as UTCTimestamp,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
  }));
}

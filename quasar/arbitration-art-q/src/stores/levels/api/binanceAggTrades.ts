import axios from 'axios';
import type { CandlestickData, LineData, UTCTimestamp } from 'lightweight-charts';

// Per-second OHLC for the breakout detail chart. Binance USDⓈ-M Futures klines
// have no `1s` interval, so seconds are reconstructed from aggregated trades
// (/fapi/v1/aggTrades via the same `/binance-api` proxy the level charts use).
const binanceHttp = axios.create({ baseURL: '/binance-api/fapi/v1' });

// Binance requires the aggTrades [startTime, endTime] window to be under 1 hour.
const MAX_WINDOW_MS = 60 * 60 * 1000 - 1;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

interface RawAggTrade {
  p: string; // price
  T: number; // trade time (ms)
}

/**
 * Fetch aggregated trades in `[startMs, endMs]` once and derive both views of the
 * breakout window: per-`bucketMs` OHLC candles (default 1s) and a raw tick line
 * (one point per trade). A single fetch feeds both charts. Window is capped to
 * Binance's <1h limit; trades are paginated forward by time.
 */
export async function fetchAggTradeSeries(
  symbol: string,
  startMs: number,
  endMs: number,
  bucketMs = 1000,
): Promise<{ candles: CandlestickData[]; ticks: LineData[] }> {
  const cappedEnd = Math.min(endMs, startMs + MAX_WINDOW_MS);
  const trades = await fetchAggTrades(symbol, startMs, cappedEnd);
  return { candles: bucketCandles(trades, bucketMs), ticks: toTicks(trades) };
}

async function fetchAggTrades(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<RawAggTrade[]> {
  const sym = symbol.toUpperCase();
  const out: RawAggTrade[] = [];
  let cursor = startMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `/aggTrades?symbol=${sym}&startTime=${cursor}&endTime=${endMs}&limit=${PAGE_LIMIT}`;
    const { data } = await binanceHttp.get<RawAggTrade[]>(url);
    if (data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_LIMIT) break;
    const last = data[data.length - 1];
    if (!last || last.T >= endMs) break;
    cursor = last.T + 1;
  }
  return out;
}

function bucketCandles(trades: readonly RawAggTrade[], bucketMs: number): CandlestickData[] {
  const bucketSec = bucketMs / 1000;
  const byBucket = new Map<number, { open: number; high: number; low: number; close: number }>();
  for (const trade of trades) {
    const price = parseFloat(trade.p);
    const time = Math.floor(trade.T / bucketMs) * bucketSec; // bucket start, seconds
    const bar = byBucket.get(time);
    if (!bar) {
      byBucket.set(time, { open: price, high: price, low: price, close: price });
    } else {
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
    }
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, bar]) => ({
      time: time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
}

// One line point per trade: price over time. Trade time (ms) maps to UTC seconds
// keeping the millisecond fraction, so dense bursts of trades stay spread out on
// the time axis. lightweight-charts requires strictly ascending times, so trades
// sharing a millisecond are nudged forward by 1ms (aggTrades are already sorted
// by time from the API).
function toTicks(trades: readonly RawAggTrade[]): LineData[] {
  const out: LineData[] = [];
  let lastTime = -Infinity;
  for (const trade of trades) {
    let time = trade.T / 1000;
    if (time <= lastTime) time = lastTime + 0.001;
    lastTime = time;
    out.push({ time: time as UTCTimestamp, value: parseFloat(trade.p) });
  }
  return out;
}

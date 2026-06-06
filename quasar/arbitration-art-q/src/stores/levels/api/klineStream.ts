import type { CandlestickData, UTCTimestamp } from 'lightweight-charts';

// Live candle updates for the levels screener charts. A single shared WebSocket
// to Binance USDⓈ-M Futures combined streams feeds every visible chart: each
// LevelChartCard subscribes to its <symbol>@kline_<interval> stream and receives
// incremental candle updates, so a grid of N charts uses ONE connection instead
// of N. Mirrors the connector's KlineStream (art-level-screener) and the
// exchanges feature: WS has no CORS, so it connects to Binance directly (the
// /binance-api proxy is only needed for REST history in binanceKlines.ts).
//
// Path note: the combined-stream path is `/market/stream`. Binance's `/ws`
// accepts SUBSCRIBE but no longer pushes data — only `/market/stream` delivers.
const STREAM_URL = 'wss://fstream.binance.com/market/stream';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Binance caps params per control message; chunk SUBSCRIBE/UNSUBSCRIBE to match.
const MAX_PARAMS_PER_MESSAGE = 100;
// Watchdog: kline streams push every ~1-2s, so prolonged silence means a dead
// (half-open) socket — force-close it to trigger a reconnect.
const STALE_TIMEOUT_MS = 30000;

// Normalized live candle pushed to subscribers. `closed` marks the kline as
// final (Binance `k.x`) — the bar won't change after this tick.
export interface LiveCandle extends CandlestickData {
  closed: boolean;
}

type Listener = (candle: LiveCandle) => void;

// Relevant fields of the Binance futures kline payload (`data.k` in the
// combined-stream envelope). Times are ms; OHLC come as strings.
interface BinanceKline {
  t: number; // kline open time (ms)
  o: string;
  h: string;
  l: string;
  c: string;
  x: boolean; // is this kline closed (final)?
}

interface KlineEnvelope {
  stream?: string;
  data?: { e?: string; k?: BinanceKline };
}

function streamName(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

// One process-wide WebSocket multiplexing every chart's kline stream. Streams
// are reference-counted by name: the first subscriber opens the socket and sends
// SUBSCRIBE, the last unsubscribe drops the stream and (when none remain) closes
// the socket. Reconnects with backoff and re-subscribes all active streams.
class KlineStreamManager {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private messageId = 1;
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  // Distinguishes an intentional close (no subscribers left) from a dropped
  // connection that must trigger a reconnect.
  private closedByUs = false;

  subscribe(symbol: string, interval: string, listener: Listener): () => void {
    const stream = streamName(symbol, interval);
    let set = this.listeners.get(stream);
    const isNewStream = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(stream, set);
    }
    set.add(listener);

    if (!this.ws) {
      this.connect();
    } else if (isNewStream && this.ws.readyState === WebSocket.OPEN) {
      this.send('SUBSCRIBE', [stream]);
    }

    return () => this.unsubscribe(stream, listener);
  }

  private unsubscribe(stream: string, listener: Listener): void {
    const set = this.listeners.get(stream);
    if (!set) return;
    set.delete(listener);
    if (set.size > 0) return;
    this.listeners.delete(stream);
    if (this.ws?.readyState === WebSocket.OPEN) this.send('UNSUBSCRIBE', [stream]);
    if (this.listeners.size === 0) this.close();
  }

  private connect(): void {
    this.closedByUs = false;
    const ws = new WebSocket(STREAM_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectMs = RECONNECT_BASE_MS;
      this.resetWatchdog();
      const streams = [...this.listeners.keys()];
      if (streams.length) this.send('SUBSCRIBE', streams);
    };
    ws.onmessage = (event) => {
      this.resetWatchdog();
      this.onMessage(event);
    };
    ws.onclose = () => {
      this.ws = null;
      this.clearWatchdog();
      // Reconnect only if the drop was unexpected and someone still cares.
      if (!this.closedByUs && this.listeners.size > 0) this.scheduleReconnect();
    };
    // Let onclose drive reconnection; closing here normalizes the error path.
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size > 0) this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }

  // Force-close a silent socket so onclose schedules a reconnect. Browser
  // WebSocket has no ping event, so only inbound messages reset the timer.
  private resetWatchdog(): void {
    this.clearWatchdog();
    this.staleTimer = setTimeout(() => this.ws?.close(), STALE_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', streams: string[]): void {
    for (let i = 0; i < streams.length; i += MAX_PARAMS_PER_MESSAGE) {
      const params = streams.slice(i, i + MAX_PARAMS_PER_MESSAGE);
      this.ws?.send(JSON.stringify({ method, params, id: this.messageId++ }));
    }
  }

  private close(): void {
    this.closedByUs = true;
    this.clearWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private onMessage(event: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return;
    }
    // Combined-stream envelope: { stream, data: { e: "kline", k: {...} } }.
    // SUBSCRIBE/UNSUBSCRIBE acks ({ result, id }) lack `stream`/`data` → skipped.
    const { stream, data } = parsed as KlineEnvelope;
    const k = data?.k;
    if (!stream || data?.e !== 'kline' || !k) return;
    const set = this.listeners.get(stream);
    if (!set || set.size === 0) return;

    const candle: LiveCandle = {
      // Binance open time is ms; lightweight-charts expects UTCTimestamp in s.
      time: Math.floor(k.t / 1000) as UTCTimestamp,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      closed: k.x === true,
    };
    for (const listener of set) listener(candle);
  }
}

const manager = new KlineStreamManager();

// Subscribe a chart to live candles for symbol+interval (interval matches the
// screener timeframe, e.g. "15m"). Returns a teardown that removes the listener
// and, when it was the last for that stream, drops the Binance subscription
// (closing the socket once nothing is left).
export function subscribeKline(
  symbol: string,
  interval: string,
  listener: Listener,
): () => void {
  return manager.subscribe(symbol, interval, listener);
}

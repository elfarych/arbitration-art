/** Одно WebSocket-соедин: combined-поток 1m-свечей для группы символов.

Используется база `/ws` с динамической подпиской (`SUBSCRIBE`/`UNSUBSCRIBE`) —
символы добавляются и удаляются без переподключения. При обрыве — авто-reconnect
с экспоненциальной задержкой и повторной подпиской на текущий набор. Событие
`open` эмитится при каждом (пере)подключении, чтобы потребитель мог сделать
переснапшот и закрыть возможный гэп. */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { chunk } from '../utils/async';
import type { Logger } from '../utils/logger';
import type { Candle } from '../types/candle';
import type { WsKlineEvent } from '../types/binance';

export interface Kline1mUpdate {
  symbol: string;
  candle: Candle;
  isClosed: boolean;
}

const MAX_PARAMS_PER_MESSAGE = 100;
const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_STALE_TIMEOUT_MS = 30_000;
/** Путь combined-потока Futures. `/ws` принимает подписку, но не отдаёт данные. */
const STREAM_PATH = '/market/stream';

type StreamEvents = {
  kline: [Kline1mUpdate];
  open: [];
};

export class KlineStream extends EventEmitter<StreamEvents> {
  private socket: WebSocket | undefined;
  private readonly symbols = new Set<string>();
  private messageId = 1;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private stopped = false;
  private staleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
    private readonly staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
  ) {
    super();
  }

  /** Подключиться и подписаться на стартовый набор символов. */
  start(symbols: readonly string[]): void {
    for (const symbol of symbols) {
      this.symbols.add(symbol);
    }
    this.connect();
  }

  addSymbols(symbols: readonly string[]): void {
    const fresh = symbols.filter((symbol) => !this.symbols.has(symbol));
    for (const symbol of fresh) {
      this.symbols.add(symbol);
    }
    if (fresh.length > 0 && this.isOpen()) {
      this.send('SUBSCRIBE', fresh);
    }
  }

  removeSymbols(symbols: readonly string[]): void {
    const known = symbols.filter((symbol) => this.symbols.has(symbol));
    for (const symbol of known) {
      this.symbols.delete(symbol);
    }
    if (known.length > 0 && this.isOpen()) {
      this.send('UNSUBSCRIBE', known);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(): void {
    const socket = new WebSocket(`${this.baseUrl}${STREAM_PATH}`);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectMs = INITIAL_RECONNECT_MS;
      this.resetWatchdog();
      if (this.symbols.size > 0) {
        this.send('SUBSCRIBE', [...this.symbols]);
      }
      this.emit('open');
    });
    socket.on('message', (data: WebSocket.RawData) => {
      this.resetWatchdog();
      this.handleMessage(data);
    });
    socket.on('ping', () => this.resetWatchdog());
    socket.on('error', (error) => this.logger.warn({ err: error }, 'WS ошибка'));
    socket.on('close', () => {
      this.clearWatchdog();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    this.logger.warn({ delay }, 'WS переподключение');
    setTimeout(() => {
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Сторож «немого» соединения: если за `staleTimeoutMs` нет ни одного сообщения
   * или ping от сервера, соединение считается мёртвым и принудительно рвётся —
   * `close` запускает обычный reconnect. Закрывает дыру с half-open сокетом.
   */
  private resetWatchdog(): void {
    this.clearWatchdog();
    if (this.stopped) {
      return;
    }
    this.staleTimer = setTimeout(() => {
      this.logger.warn({ staleTimeoutMs: this.staleTimeoutMs }, 'WS тишина — принудительный разрыв');
      this.socket?.terminate();
    }, this.staleTimeoutMs);
  }

  private clearWatchdog(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    const event = unwrap(safeParse(data.toString()));
    if (!isKlineEvent(event)) {
      return;
    }
    const k = event.k;
    this.emit('kline', {
      symbol: k.s,
      isClosed: k.x,
      candle: {
        openTime: k.t,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
      },
    });
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: readonly string[]): void {
    const streams = symbols.map(streamName);
    for (const params of chunk(streams, MAX_PARAMS_PER_MESSAGE)) {
      this.socket?.send(JSON.stringify({ method, params, id: this.messageId++ }));
    }
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

function streamName(symbol: string): string {
  return `${symbol.toLowerCase()}@kline_1m`;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Распаковать combined-обёртку `{stream, data}` → `data`; иначе вернуть как есть. */
function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function isKlineEvent(value: unknown): value is WsKlineEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { e?: unknown }).e === 'kline' &&
    typeof (value as { k?: unknown }).k === 'object'
  );
}

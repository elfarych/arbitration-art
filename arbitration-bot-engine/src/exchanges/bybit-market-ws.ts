import WebSocket from 'ws';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import type { MarketWsClient } from './market-ws.js';
import { bybitToUnified, unifiedToBybit } from './symbols.js';
import { logger } from '../utils/logger.js';

const TAG = 'BybitMarketWs';
const MAINNET_URL = 'wss://stream.bybit.com/v5/public/linear';
const TESTNET_URL = 'wss://stream-testnet.bybit.com/v5/public/linear';
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const DEPTH = 50 as const;

interface BybitOrderbookMessage {
    topic?: string;
    type?: 'snapshot' | 'delta';
    ts?: number;
    cts?: number;
    data?: {
        s?: string;
        b?: [string, string][];
        a?: [string, string][];
        u?: number;
        seq?: number;
    };
}

interface LocalBook {
    bids: Map<number, number>;
    asks: Map<number, number>;
}

/**
 * Bybit V5 linear public orderbook stream client.
 *
 * Bybit emits one `snapshot` followed by `delta` messages per symbol. The
 * client maintains a per-symbol price→qty map, applies deltas, and pushes
 * the top-N levels (sorted) into the shared `OrderBookStore` on every tick.
 * Includes ping/pong heartbeat and exponential reconnect.
 */
export class BybitMarketWs implements MarketWsClient {
    readonly exchange = 'bybit';

    private socket: WebSocket | null = null;
    private readonly books = new Map<string, LocalBook>();
    private symbols: string[] = [];
    private closedByUser = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly store: OrderBookStore,
        private readonly useTestnet: boolean,
    ) {}

    isOpen(): boolean {
        return !!this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    async connect(symbols: string[]): Promise<void> {
        this.closedByUser = false;
        this.symbols = symbols;
        await this.openSocket();
    }

    async close(): Promise<void> {
        this.closedByUser = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this.books.clear();
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>(resolve => {
            const finish = () => resolve();
            socket.once('close', finish);
            try { socket.close(); } catch { /* socket already torn down */ }
            setTimeout(finish, 1_000).unref();
        });
    }

    private async openSocket(): Promise<void> {
        const url = this.useTestnet ? TESTNET_URL : MAINNET_URL;
        const socket = new WebSocket(url);
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            const onOpen = () => { socket.off('error', onError); resolve(); };
            const onError = (e: Error) => { socket.off('open', onOpen); reject(e); };
            socket.once('open', onOpen);
            socket.once('error', onError);
        });

        socket.on('message', data => this.handleMessage(data.toString()));
        socket.on('close', () => this.handleClose());
        socket.on('error', err => logger.warn(TAG, `socket error: ${(err as Error).message}`));

        const args = this.symbols.map(symbol => `orderbook.${DEPTH}.${unifiedToBybit(symbol)}`);
        socket.send(JSON.stringify({ op: 'subscribe', args }));
        this.startPing();
        this.reconnectAttempts = 0;
    }

    private startPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                try { this.socket.send(JSON.stringify({ op: 'ping' })); } catch { /* socket closing */ }
            }
        }, PING_INTERVAL_MS);
        this.pingTimer.unref();
    }

    private handleClose(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.closedByUser) return;
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closedByUser || this.reconnectTimer) return;
        const delay = Math.min(RECONNECT_INITIAL_MS * (this.reconnectAttempts + 1), RECONNECT_MAX_MS);
        this.reconnectAttempts++;
        logger.warn(TAG, `WS closed; reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Reset local books so stale deltas do not accumulate.
            this.books.clear();
            this.openSocket().catch(err => {
                logger.error(TAG, `Reconnect failed: ${(err as Error).message}`);
                this.scheduleReconnect();
            });
        }, delay);
        this.reconnectTimer.unref();
    }

    private handleMessage(raw: string): void {
        let message: BybitOrderbookMessage;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        const data = message.data;
        if (!data?.s || !message.type) return;

        const book = this.books.get(data.s) ?? { bids: new Map<number, number>(), asks: new Map<number, number>() };
        if (message.type === 'snapshot') {
            book.bids.clear();
            book.asks.clear();
        }
        applyLevels(book.bids, data.b ?? []);
        applyLevels(book.asks, data.a ?? []);
        this.books.set(data.s, book);

        this.store.set({
            exchange: this.exchange,
            symbol: bybitToUnified(data.s),
            bids: sortLevels(book.bids, 'desc', DEPTH),
            asks: sortLevels(book.asks, 'asc', DEPTH),
            exchangeTimestamp: message.cts ?? message.ts ?? null,
            localTimestamp: Date.now(),
            sequence: data.seq ?? data.u ?? null,
        });
    }
}

function applyLevels(target: Map<number, number>, levels: [string, string][]): void {
    for (const [priceText, qtyText] of levels) {
        const price = Number(priceText);
        const qty = Number(qtyText);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
        if (qty <= 0) target.delete(price);
        else target.set(price, qty);
    }
}

function sortLevels(levels: Map<number, number>, direction: 'asc' | 'desc', limit: number): [number, number][] {
    const entries = [...levels.entries()] as [number, number][];
    entries.sort((left, right) => direction === 'asc' ? left[0] - right[0] : right[0] - left[0]);
    return entries.slice(0, limit);
}

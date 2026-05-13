import WebSocket from 'ws';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import type { MarketWsClient } from './market-ws.js';
import { underscoredToUnified, unifiedToUnderscored } from './symbols.js';
import { logger } from '../utils/logger.js';

const TAG = 'GateMarketWs';
const MAINNET_URL = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
const TESTNET_URL = 'wss://fx-ws-testnet.gateio.ws/v4/ws/usdt';
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const DEPTH = 20 as const;
const INTERVAL = '100ms' as const;

interface GateOrderbookMessage {
    time?: number;
    time_ms?: number;
    channel?: string;
    event?: string;
    result?: {
        t?: number;
        contract?: string;
        asks?: { p: string; s: number }[];
        bids?: { p: string; s: number }[];
        id?: number;
    };
}

/**
 * Gate USDT futures full-depth stream client.
 *
 * Uses `futures.order_book` with a `100ms` interval payload so the exchange
 * pushes a full top-N snapshot on every tick. No delta merging required.
 * Ping every 20s and exponential reconnect on transport failures.
 */
export class GateMarketWs implements MarketWsClient {
    readonly exchange = 'gate';

    private socket: WebSocket | null = null;
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

        for (const symbol of this.symbols) {
            const exchangeSymbol = unifiedToUnderscored(symbol);
            socket.send(JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                channel: 'futures.order_book',
                event: 'subscribe',
                payload: [exchangeSymbol, String(DEPTH), INTERVAL],
            }));
        }
        this.startPing();
        this.reconnectAttempts = 0;
    }

    private startPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                try {
                    this.socket.send(JSON.stringify({
                        time: Math.floor(Date.now() / 1000),
                        channel: 'futures.ping',
                    }));
                } catch { /* socket closing */ }
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
            this.openSocket().catch(err => {
                logger.error(TAG, `Reconnect failed: ${(err as Error).message}`);
                this.scheduleReconnect();
            });
        }, delay);
        this.reconnectTimer.unref();
    }

    private handleMessage(raw: string): void {
        let message: GateOrderbookMessage;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.channel !== 'futures.order_book' || message.event !== 'all') return;
        const result = message.result;
        if (!result?.contract || !result.asks || !result.bids) return;

        this.store.set({
            exchange: this.exchange,
            symbol: underscoredToUnified(result.contract),
            bids: parseLevels(result.bids, 'desc'),
            asks: parseLevels(result.asks, 'asc'),
            exchangeTimestamp: result.t ?? message.time_ms ?? null,
            localTimestamp: Date.now(),
            sequence: result.id ?? null,
        });
    }
}

function parseLevels(raw: { p: string; s: number }[], direction: 'asc' | 'desc'): [number, number][] {
    const out: [number, number][] = [];
    for (const level of raw) {
        const price = Number(level.p);
        // Gate publishes order book size in contracts. The size is converted to
        // base coin units by the REST client's market-info conversion when the
        // engine routes orders; the WS snapshot keeps the native contract count,
        // matching how VWAP is consumed elsewhere.
        const qty = Number(level.s);
        if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
            out.push([price, qty]);
        }
    }
    out.sort((left, right) => direction === 'asc' ? left[0] - right[0] : right[0] - left[0]);
    return out;
}

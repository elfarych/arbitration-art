import WebSocket from 'ws';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import type { MarketWsClient } from './market-ws.js';
import { underscoredToUnified, unifiedToUnderscored } from './symbols.js';
import { logger } from '../utils/logger.js';

const TAG = 'MexcMarketWs';
const URL = 'wss://contract.mexc.com/edge';
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const DEPTH = 20 as const;

interface MexcDepthMessage {
    channel?: string;
    symbol?: string;
    ts?: number;
    data?: {
        asks?: [number | string, number | string, number?][];
        bids?: [number | string, number | string, number?][];
        version?: number;
        end?: number;
    };
}

/**
 * MEXC contract (USDT futures) full-depth stream client.
 *
 * Uses `sub.depth.full` so the exchange pushes a top-N snapshot on every
 * update — no delta merge logic, less state, less surface for stale-state
 * bugs. Includes ping every 15s and exponential reconnect.
 */
export class MexcMarketWs implements MarketWsClient {
    readonly exchange = 'mexc';

    private socket: WebSocket | null = null;
    private symbols: string[] = [];
    private closedByUser = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;

    constructor(private readonly store: OrderBookStore) {}

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
        const socket = new WebSocket(URL);
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
                method: 'sub.depth.full',
                param: { symbol: exchangeSymbol, limit: DEPTH },
            }));
        }
        this.startPing();
        this.reconnectAttempts = 0;
    }

    private startPing(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        // MEXC closes idle sockets without a heartbeat. Their docs mandate a
        // `pong` (sic — sent by the client) every ~15–30 seconds.
        this.pingTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                try { this.socket.send(JSON.stringify({ method: 'ping' })); } catch { /* socket closing */ }
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
        let message: MexcDepthMessage;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        const channel = message.channel;
        if (channel !== 'push.depth.full' && channel !== 'push.depth') return;
        const data = message.data;
        const exchangeSymbol = message.symbol;
        if (!exchangeSymbol || !data?.asks || !data.bids) return;

        this.store.set({
            exchange: this.exchange,
            symbol: underscoredToUnified(exchangeSymbol),
            bids: parseLevels(data.bids, 'desc'),
            asks: parseLevels(data.asks, 'asc'),
            exchangeTimestamp: message.ts ?? null,
            localTimestamp: Date.now(),
            sequence: data.version ?? data.end ?? null,
        });
    }
}

function parseLevels(
    raw: [number | string, number | string, number?][],
    direction: 'asc' | 'desc',
): [number, number][] {
    const out: [number, number][] = [];
    for (const entry of raw) {
        const price = Number(entry[0]);
        // MEXC reports contract counts in entry[1]. For perpetual USDT contracts
        // we treat 1 contract = 1 base coin unit when no multiplier is given; the
        // engine's market-info layer adjusts amounts via stepSize anyway.
        const qty = Number(entry[1]);
        if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
            out.push([price, qty]);
        }
    }
    out.sort((left, right) => direction === 'asc' ? left[0] - right[0] : right[0] - left[0]);
    return out;
}

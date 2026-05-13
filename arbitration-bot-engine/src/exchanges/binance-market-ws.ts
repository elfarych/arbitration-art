import WebSocket from 'ws';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import type { MarketWsClient } from './market-ws.js';
import { binanceToUnified, unifiedToBinance } from './symbols.js';
import { logger } from '../utils/logger.js';

const TAG = 'BinanceMarketWs';
const MAINNET_BASE = 'wss://fstream.binance.com/stream';
const TESTNET_BASE = 'wss://stream.binancefuture.com/stream';
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface BinanceCombinedMessage {
    stream?: string;
    data?: BinanceDepthPayload;
}

interface BinanceDepthPayload {
    e?: string;
    E?: number;
    T?: number;
    s?: string;
    u?: number;
    b?: [string, string][];
    a?: [string, string][];
}

/**
 * Binance USD-M futures partial depth stream client.
 *
 * Subscribes to `<symbol>@depth20@100ms` per symbol via the combined stream
 * URL, which delivers a top-20 snapshot every 100ms with no merge logic
 * required. Snapshots are pushed straight into the `OrderBookStore`.
 */
export class BinanceMarketWs implements MarketWsClient {
    readonly exchange = 'binance';

    private socket: WebSocket | null = null;
    private symbols: string[] = [];
    private closedByUser = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;

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
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) return;
        await new Promise<void>(resolve => {
            const finish = () => resolve();
            socket.once('close', finish);
            try { socket.close(); } catch { /* socket already torn down */ }
            // Safety net so a hung close does not block shutdown forever.
            setTimeout(finish, 1_000).unref();
        });
    }

    private async openSocket(): Promise<void> {
        const streams = this.symbols
            .map(symbol => `${unifiedToBinance(symbol).toLowerCase()}@depth20@100ms`)
            .join('/');
        const url = `${this.useTestnet ? TESTNET_BASE : MAINNET_BASE}?streams=${streams}`;
        const socket = new WebSocket(url);
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
                socket.off('error', onError);
                this.reconnectAttempts = 0;
                resolve();
            };
            const onError = (error: Error) => {
                socket.off('open', onOpen);
                reject(error);
            };
            socket.once('open', onOpen);
            socket.once('error', onError);
        });

        socket.on('message', data => this.handleMessage(data.toString()));
        socket.on('close', () => this.handleClose());
        socket.on('error', err => logger.warn(TAG, `socket error: ${(err as Error).message}`));
    }

    private handleClose(): void {
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
        let message: BinanceCombinedMessage;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        const payload = message.data ?? (message as unknown as BinanceDepthPayload);
        if (!payload?.s || !payload.b || !payload.a) return;

        this.store.set({
            exchange: this.exchange,
            symbol: binanceToUnified(payload.s),
            bids: parseLevels(payload.b),
            asks: parseLevels(payload.a),
            exchangeTimestamp: payload.T ?? payload.E ?? null,
            localTimestamp: Date.now(),
            sequence: payload.u ?? null,
        });
    }
}

function parseLevels(levels: [string, string][]): [number, number][] {
    const out: [number, number][] = [];
    for (const [priceText, qtyText] of levels) {
        const price = Number(priceText);
        const qty = Number(qtyText);
        if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
            out.push([price, qty]);
        }
    }
    return out;
}

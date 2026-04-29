import WebSocket from 'ws';
import { OrderBookStore } from '../../market-data/orderbook-store.js';
import type { MarketWsClient } from '../exchange-types.js';
import { exchangeToUnified, unifiedToExchangeSymbol } from '../symbols.js';

const MAINNET_BASE = 'wss://fstream.binance.com/public/ws';
const TESTNET_BASE = 'wss://stream.binancefuture.com/ws';

interface BinanceDepthMessage {
    data?: BinanceDepthPayload;
    e?: string;
    E?: number;
    T?: number;
    s?: string;
    u?: number;
    b?: [string, string][];
    a?: [string, string][];
}

interface BinanceDepthPayload {
    E?: number;
    T?: number;
    s?: string;
    u?: number;
    b?: [string, string][];
    a?: [string, string][];
}

export class BinanceUsdmMarketWs implements MarketWsClient {
    readonly exchange = 'binance' as const;
    private socket: WebSocket | null = null;

    constructor(
        private readonly store: OrderBookStore,
        private readonly useTestnet: boolean,
        private readonly depth: number,
        private readonly wsFactory?: (url: string) => WebSocket,
    ) {}

    async connect(symbols: string[]): Promise<void> {
        await this.close();
        const levels = this.depth <= 5 ? 5 : this.depth <= 10 ? 10 : 20;
        const streams = symbols
            .map(symbol => `${unifiedToExchangeSymbol(symbol).toLowerCase()}@depth${levels}@100ms`)
            .join('/');
        const base = this.useTestnet ? TESTNET_BASE : MAINNET_BASE;
        const url = `${base}/${streams}`;
        const socket = this.wsFactory ? this.wsFactory(url) : new WebSocket(url);
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
        });

        socket.on('message', data => this.handleMessage(data.toString()));
    }

    async close(): Promise<void> {
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            return;
        }
        await new Promise<void>(resolve => {
            socket.once('close', () => resolve());
            socket.close();
            setTimeout(resolve, 1000).unref();
        });
    }

    private handleMessage(raw: string): void {
        let message: BinanceDepthMessage;
        try {
            message = JSON.parse(raw) as BinanceDepthMessage;
        } catch {
            return;
        }

        const payload = message.data ?? message;
        if (!payload.s || !payload.b || !payload.a) {
            return;
        }

        this.store.set({
            exchange: this.exchange,
            symbol: exchangeToUnified(payload.s),
            bids: parseLevels(payload.b, 'desc'),
            asks: parseLevels(payload.a, 'asc'),
            exchangeTimestamp: payload.T ?? payload.E ?? null,
            localTimestamp: Date.now(),
            sequence: payload.u ?? null,
        });
    }
}

function parseLevels(levels: [string, string][], sort: 'asc' | 'desc'): [number, number][] {
    const parsed = levels
        .map(([price, qty]) => [Number(price), Number(qty)] as [number, number])
        .filter(([price, qty]) => Number.isFinite(price) && Number.isFinite(qty) && qty > 0);
    parsed.sort((left, right) => sort === 'asc' ? left[0] - right[0] : right[0] - left[0]);
    return parsed;
}

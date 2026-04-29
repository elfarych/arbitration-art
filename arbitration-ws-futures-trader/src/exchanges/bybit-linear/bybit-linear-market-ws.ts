import WebSocket from 'ws';
import { OrderBookStore } from '../../market-data/orderbook-store.js';
import type { MarketWsClient } from '../exchange-types.js';
import { exchangeToUnified, unifiedToExchangeSymbol } from '../symbols.js';

const MAINNET_URL = 'wss://stream.bybit.com/v5/public/linear';
const TESTNET_URL = 'wss://stream-testnet.bybit.com/v5/public/linear';

interface BybitOrderbookMessage {
    topic?: string;
    type?: 'snapshot' | 'delta';
    ts?: number;
    data?: {
        s?: string;
        b?: [string, string][];
        a?: [string, string][];
        u?: number;
        seq?: number;
    };
    cts?: number;
}

interface LocalBook {
    bids: Map<number, number>;
    asks: Map<number, number>;
}

export class BybitLinearMarketWs implements MarketWsClient {
    readonly exchange = 'bybit' as const;
    private socket: WebSocket | null = null;
    private readonly books = new Map<string, LocalBook>();

    constructor(
        private readonly store: OrderBookStore,
        private readonly useTestnet: boolean,
        private readonly depth: number,
        private readonly wsFactory?: (url: string) => WebSocket,
    ) {}

    async connect(symbols: string[]): Promise<void> {
        await this.close();
        const socket = this.wsFactory ? this.wsFactory(this.url()) : new WebSocket(this.url());
        this.socket = socket;
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
        });

        socket.on('message', data => this.handleMessage(data.toString()));
        socket.send(JSON.stringify({
            op: 'subscribe',
            args: symbols.map(symbol => `orderbook.${this.bybitDepth()}.${unifiedToExchangeSymbol(symbol)}`),
        }));
    }

    async close(): Promise<void> {
        const socket = this.socket;
        this.socket = null;
        this.books.clear();
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
        let message: BybitOrderbookMessage;
        try {
            message = JSON.parse(raw) as BybitOrderbookMessage;
        } catch {
            return;
        }

        const data = message.data;
        if (!data?.s || !message.type) {
            return;
        }

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
            symbol: exchangeToUnified(data.s),
            bids: sortLevels(book.bids, 'desc', this.bybitDepth()),
            asks: sortLevels(book.asks, 'asc', this.bybitDepth()),
            exchangeTimestamp: message.cts ?? message.ts ?? null,
            localTimestamp: Date.now(),
            sequence: data.seq ?? data.u ?? null,
        });
    }

    private url(): string {
        return this.useTestnet ? TESTNET_URL : MAINNET_URL;
    }

    private bybitDepth(): 1 | 50 | 200 | 1000 {
        if (this.depth <= 1) {
            return 1;
        }
        if (this.depth <= 50) {
            return 50;
        }
        if (this.depth <= 200) {
            return 200;
        }
        return 1000;
    }
}

function applyLevels(target: Map<number, number>, levels: [string, string][]): void {
    for (const [priceText, qtyText] of levels) {
        const price = Number(priceText);
        const qty = Number(qtyText);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) {
            continue;
        }
        if (qty <= 0) {
            target.delete(price);
        } else {
            target.set(price, qty);
        }
    }
}

function sortLevels(levels: Map<number, number>, sort: 'asc' | 'desc', limit: number): [number, number][] {
    return [...levels.entries()]
        .sort((left, right) => sort === 'asc' ? left[0] - right[0] : right[0] - left[0])
        .slice(0, limit);
}

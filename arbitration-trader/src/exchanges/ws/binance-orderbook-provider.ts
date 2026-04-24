import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { config } from '../../config.js';
import type { OrderBookProvider, OrderBookSnapshot } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { binanceToUnified, unifiedToBinance } from '../symbols.js';
import { OrderBookStore } from './orderbook-store.js';

const TAG = 'BinanceOrderBookWs';
const MAX_BUFFERED_EVENTS = 2000;

type BinanceDepthLevel = [string, string];

interface BinanceDepthEvent {
    e: 'depthUpdate';
    E: number;
    T?: number;
    s: string;
    U: number;
    u: number;
    pu: number;
    b: BinanceDepthLevel[];
    a: BinanceDepthLevel[];
}

export class BinanceOrderBookProvider implements OrderBookProvider {
    public readonly exchange = 'Binance';

    private readonly httpClient: AxiosInstance;
    private readonly store: OrderBookStore;
    private readonly useTestnet: boolean;
    private readonly depthLimit: number;
    private ws: WebSocket | null = null;
    private symbols: string[] = [];
    private listeners = new Set<(symbol: string) => void>();
    private buffers = new Map<string, BinanceDepthEvent[]>();
    private resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private isClosed = false;

    constructor(options: { useTestnet?: boolean; depthLimit?: number } = {}) {
        this.useTestnet = options.useTestnet ?? config.useTestnet;
        this.depthLimit = this.normalizeDepthLimit(options.depthLimit ?? config.orderbookLimit);
        this.store = new OrderBookStore(this.depthLimit);
        this.httpClient = axios.create({
            baseURL: this.useTestnet
                ? 'https://testnet.binancefuture.com'
                : 'https://fapi.binance.com',
            timeout: 10000,
        });
    }

    async connect(): Promise<void> {
        this.isClosed = false;
    }

    async subscribe(symbols: string[]): Promise<void> {
        this.symbols = [...new Set([...this.symbols, ...symbols])];
        for (const symbol of this.symbols) {
            if (!this.buffers.has(symbol)) {
                this.buffers.set(symbol, []);
            }
        }

        await this.openSocket();
        await this.initializeSymbols(this.symbols);
    }

    async unsubscribe(symbols: string[]): Promise<void> {
        const removed = new Set(symbols);
        this.symbols = this.symbols.filter(symbol => !removed.has(symbol));
        for (const symbol of symbols) {
            this.buffers.delete(symbol);
            const timer = this.resyncTimers.get(symbol);
            if (timer) {
                clearTimeout(timer);
                this.resyncTimers.delete(symbol);
            }
        }
    }

    getOrderBook(symbol: string): OrderBookSnapshot | null {
        const snapshot = this.store.getOrderBook(symbol);
        if (!snapshot?.isSynced) {
            return null;
        }

        return snapshot;
    }

    onUpdate(listener: (symbol: string) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async close(): Promise<void> {
        this.isClosed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const timer of this.resyncTimers.values()) {
            clearTimeout(timer);
        }
        this.resyncTimers.clear();

        const socket = this.ws;
        this.ws = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            return;
        }

        await new Promise<void>(resolve => {
            socket.once('close', () => resolve());
            socket.close();
            setTimeout(resolve, 1000);
        });
    }

    private async openSocket(): Promise<void> {
        if (this.symbols.length === 0) {
            return;
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        const streams = this.symbols
            .map(symbol => `${unifiedToBinance(symbol).toLowerCase()}@depth@100ms`)
            .join('/');
        const baseUrl = this.useTestnet
            ? 'wss://stream.binancefuture.com'
            : 'wss://fstream.binance.com';
        const url = `${baseUrl}/stream?streams=${streams}`;

        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(url);
            this.ws = socket;

            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error('Binance websocket connection timeout'));
            }, 15000);

            socket.on('message', data => this.handleMessage(data));
            socket.on('close', () => {
                clearTimeout(timeout);
                if (this.ws === socket) {
                    this.ws = null;
                }
                this.scheduleReconnect();
            });
            socket.on('error', error => {
                logger.warn(TAG, `WebSocket error: ${(error as Error).message}`);
            });
            socket.once('open', () => {
                clearTimeout(timeout);
                this.reconnectAttempts = 0;
                logger.info(TAG, `Connected to Binance Futures depth stream for ${this.symbols.length} symbols.`);
                resolve();
            });
            socket.once('error', error => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    private handleMessage(raw: WebSocket.RawData): void {
        try {
            const parsed = JSON.parse(raw.toString());
            const event: BinanceDepthEvent | undefined = parsed.data ?? parsed;
            if (!event || event.e !== 'depthUpdate' || !event.s) {
                return;
            }

            const symbol = binanceToUnified(event.s);
            if (!this.symbols.includes(symbol)) {
                return;
            }

            const snapshot = this.store.getOrderBook(symbol);
            if (!snapshot?.isSynced) {
                this.bufferEvent(symbol, event);
                return;
            }

            this.applyLiveEvent(symbol, event);
        } catch (error: any) {
            logger.warn(TAG, `Failed to parse Binance depth message: ${error.message}`);
        }
    }

    private async initializeSymbols(symbols: string[]): Promise<void> {
        const batchSize = 5;
        for (let index = 0; index < symbols.length; index += batchSize) {
            const batch = symbols.slice(index, index + batchSize);
            await Promise.all(batch.map(symbol => this.initializeSymbol(symbol)));
            if (index + batchSize < symbols.length) {
                await this.sleep(250);
            }
        }
    }

    private async initializeSymbol(symbol: string): Promise<void> {
        const binanceSymbol = unifiedToBinance(symbol);
        try {
            const response = await this.httpClient.get('/fapi/v1/depth', {
                params: {
                    symbol: binanceSymbol,
                    limit: this.depthLimit,
                },
            });
            const snapshot = response.data;
            const lastUpdateId = Number(snapshot.lastUpdateId);
            this.store.applySnapshot(
                symbol,
                this.parseLevels(snapshot.bids ?? []),
                this.parseLevels(snapshot.asks ?? []),
                lastUpdateId,
                Number(snapshot.E ?? snapshot.T) || null,
            );

            const buffered = this.buffers.get(symbol) ?? [];
            this.buffers.set(symbol, []);
            if (!this.applyBufferedEvents(symbol, lastUpdateId, buffered)) {
                this.scheduleSymbolResync(symbol, 'buffer did not bridge REST snapshot');
                return;
            }

            this.emit(symbol);
        } catch (error: any) {
            this.store.markUnsynced(symbol);
            logger.warn(TAG, `Failed to initialize ${symbol} orderbook: ${error.message}`);
            this.scheduleSymbolResync(symbol, 'snapshot request failed');
        }
    }

    private applyBufferedEvents(symbol: string, lastUpdateId: number, events: BinanceDepthEvent[]): boolean {
        const candidates = events
            .filter(event => event.u >= lastUpdateId)
            .sort((left, right) => left.U - right.U);

        if (candidates.length === 0) {
            return true;
        }

        const firstIndex = candidates.findIndex(event => event.U <= lastUpdateId + 1 && event.u >= lastUpdateId + 1);
        if (firstIndex === -1) {
            return false;
        }

        let previousUpdateId = lastUpdateId;
        let isFirst = true;
        for (const event of candidates.slice(firstIndex)) {
            if (!isFirst && event.pu !== previousUpdateId) {
                return false;
            }

            this.applyDepthEvent(symbol, event);
            previousUpdateId = event.u;
            isFirst = false;
        }

        return true;
    }

    private applyLiveEvent(symbol: string, event: BinanceDepthEvent): void {
        const previousSequence = Number(this.store.getSequence(symbol));
        if (Number.isFinite(previousSequence) && event.pu !== previousSequence) {
            this.bufferEvent(symbol, event);
            this.scheduleSymbolResync(symbol, `sequence gap: pu=${event.pu}, local=${previousSequence}`);
            return;
        }

        this.applyDepthEvent(symbol, event);
        this.emit(symbol);
    }

    private applyDepthEvent(symbol: string, event: BinanceDepthEvent): void {
        this.store.applyAbsoluteDelta(
            symbol,
            this.parseLevels(event.b),
            this.parseLevels(event.a),
            event.u,
            event.T ?? event.E ?? null,
        );
    }

    private bufferEvent(symbol: string, event: BinanceDepthEvent): void {
        const buffer = this.buffers.get(symbol) ?? [];
        buffer.push(event);
        if (buffer.length > MAX_BUFFERED_EVENTS) {
            buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
        }
        this.buffers.set(symbol, buffer);
    }

    private scheduleSymbolResync(symbol: string, reason: string): void {
        if (this.resyncTimers.has(symbol) || this.isClosed) {
            return;
        }

        logger.warn(TAG, `Resyncing ${symbol}: ${reason}`);
        this.store.markUnsynced(symbol);
        const timer = setTimeout(() => {
            this.resyncTimers.delete(symbol);
            void this.initializeSymbol(symbol);
        }, 1000);
        this.resyncTimers.set(symbol, timer);
    }

    private scheduleReconnect(): void {
        if (this.isClosed || this.reconnectTimer) {
            return;
        }

        for (const symbol of this.symbols) {
            this.store.markUnsynced(symbol);
            this.buffers.set(symbol, []);
        }

        const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        logger.warn(TAG, `WebSocket disconnected. Reconnecting in ${delay} ms.`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.openSocket()
                .then(() => this.initializeSymbols(this.symbols))
                .catch((error: any) => {
                    logger.warn(TAG, `Reconnect failed: ${error.message}`);
                    this.scheduleReconnect();
                });
        }, delay);
    }

    private emit(symbol: string): void {
        for (const listener of this.listeners) {
            listener(symbol);
        }
    }

    private parseLevels(levels: BinanceDepthLevel[]): [number, number][] {
        return levels.map(([price, amount]) => [Number(price), Number(amount)]);
    }

    private normalizeDepthLimit(limit: number): number {
        const allowed = [5, 10, 20, 50, 100, 500, 1000];
        return allowed.find(value => limit <= value) ?? 1000;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

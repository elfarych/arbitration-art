import WebSocket from 'ws';
import { config } from '../../config.js';
import type { OrderBookProvider, OrderBookSnapshot } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { bybitToUnified, unifiedToBybit } from '../symbols.js';
import { OrderBookStore } from './orderbook-store.js';

const TAG = 'BybitOrderBookWs';
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_STALE_MS = 10_000;
const MAX_SUBSCRIBE_CHARS = 18_000;

type BybitDepthLevel = [string, string];

interface BybitOrderBookPayload {
    s: string;
    b?: BybitDepthLevel[];
    a?: BybitDepthLevel[];
    u?: number;
    seq?: number;
}

interface BybitWsMessage {
    topic?: string;
    type?: 'snapshot' | 'delta';
    ts?: number;
    cts?: number;
    data?: BybitOrderBookPayload;
    op?: string;
    success?: boolean;
    ret_msg?: string;
    req_id?: string;
}

export class BybitOrderBookProvider implements OrderBookProvider {
    public readonly exchange = 'Bybit';

    private readonly store: OrderBookStore;
    private readonly useTestnet: boolean;
    private readonly depthLimit: number;
    private ws: WebSocket | null = null;
    private symbols: string[] = [];
    private listeners = new Set<(symbol: string) => void>();
    private staleSymbols = new Set<string>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts = 0;
    private isClosed = false;

    constructor(options: { useTestnet?: boolean; depthLimit?: number } = {}) {
        this.useTestnet = options.useTestnet ?? config.useTestnet;
        this.depthLimit = this.normalizeDepthLimit(options.depthLimit ?? config.orderbookLimit);
        this.store = new OrderBookStore(this.depthLimit);
    }

    async connect(): Promise<void> {
        this.isClosed = false;
    }

    async subscribe(symbols: string[]): Promise<void> {
        const uniqueSymbols = [...new Set(symbols)];
        const newSymbols = uniqueSymbols.filter(symbol => !this.symbols.includes(symbol));
        if (newSymbols.length === 0) {
            return;
        }

        this.symbols = [...this.symbols, ...newSymbols];
        await this.openSocket();
        this.sendSubscription('subscribe', newSymbols);
    }

    async unsubscribe(symbols: string[]): Promise<void> {
        const removed = new Set(symbols);
        this.symbols = this.symbols.filter(symbol => !removed.has(symbol));
        for (const symbol of symbols) {
            this.staleSymbols.delete(symbol);
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.sendSubscription('unsubscribe', symbols);
        }
    }

    getOrderBook(symbol: string): OrderBookSnapshot | null {
        const snapshot = this.store.getOrderBook(symbol);
        if (!snapshot?.isSynced) {
            return null;
        }

        if (Date.now() - snapshot.localTimestamp > MAX_STALE_MS) {
            if (!this.staleSymbols.has(symbol)) {
                this.staleSymbols.add(symbol);
                logger.warn(TAG, `Orderbook for ${symbol} is stale; blocking trading until the next Bybit snapshot/delta.`);
            }
            return null;
        }

        this.staleSymbols.delete(symbol);
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
        this.stopHeartbeat();

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
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        const url = this.useTestnet
            ? 'wss://stream-testnet.bybit.com/v5/public/linear'
            : 'wss://stream.bybit.com/v5/public/linear';

        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(url);
            this.ws = socket;

            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error('Bybit websocket connection timeout'));
            }, 15000);

            socket.on('message', data => this.handleMessage(data));
            socket.on('close', () => {
                clearTimeout(timeout);
                this.stopHeartbeat();
                if (this.ws === socket) {
                    this.ws = null;
                }
                this.markAllUnsynced();
                this.scheduleReconnect();
            });
            socket.on('error', error => {
                logger.warn(TAG, `WebSocket error: ${(error as Error).message}`);
            });
            socket.once('open', () => {
                clearTimeout(timeout);
                this.reconnectAttempts = 0;
                this.startHeartbeat();
                logger.info(TAG, `Connected to Bybit linear orderbook stream for ${this.symbols.length} symbols.`);
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
            const message = JSON.parse(raw.toString()) as BybitWsMessage;

            if (message.op === 'ping' || message.op === 'pong' || message.ret_msg === 'pong') {
                return;
            }

            if (message.success === false) {
                logger.warn(TAG, `Bybit websocket command failed: ${message.ret_msg || 'unknown error'}`);
                return;
            }

            if (!message.topic?.startsWith('orderbook.') || !message.data?.s) {
                return;
            }

            const symbol = bybitToUnified(message.data.s);
            if (!this.symbols.includes(symbol)) {
                return;
            }

            if (message.type === 'snapshot' || message.data.u === 1) {
                this.applySnapshot(symbol, message);
                return;
            }

            if (message.type === 'delta') {
                this.applyDelta(symbol, message);
            }
        } catch (error: any) {
            logger.warn(TAG, `Failed to parse Bybit orderbook message: ${error.message}`);
        }
    }

    private applySnapshot(symbol: string, message: BybitWsMessage): void {
        const data = message.data!;
        this.store.applySnapshot(
            symbol,
            this.parseLevels(data.b ?? []),
            this.parseLevels(data.a ?? []),
            data.u ?? data.seq ?? null,
            message.cts ?? message.ts ?? null,
        );
        this.staleSymbols.delete(symbol);
        this.emit(symbol);
    }

    private applyDelta(symbol: string, message: BybitWsMessage): void {
        const data = message.data!;
        const current = this.store.getOrderBook(symbol);
        if (!current?.isSynced) {
            return;
        }

        const updateId = data.u ?? data.seq ?? null;
        const previousUpdateId = Number(current.sequence);
        if (
            updateId !== null
            && Number.isFinite(previousUpdateId)
            && Number(updateId) <= previousUpdateId
        ) {
            return;
        }

        this.store.applyAbsoluteDelta(
            symbol,
            this.parseLevels(data.b ?? []),
            this.parseLevels(data.a ?? []),
            updateId,
            message.cts ?? message.ts ?? null,
        );
        this.staleSymbols.delete(symbol);
        this.emit(symbol);
    }

    private sendSubscription(op: 'subscribe' | 'unsubscribe', symbols: string[]): void {
        const socket = this.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN || symbols.length === 0) {
            return;
        }

        const topics = symbols.map(symbol => `orderbook.${this.depthLimit}.${unifiedToBybit(symbol)}`);
        const chunks = this.chunkTopics(topics);
        chunks.forEach((args, index) => {
            socket.send(JSON.stringify({
                op,
                args,
                req_id: `bybit_${op}_${Date.now()}_${index}`,
            }));
        });
    }

    private scheduleReconnect(): void {
        if (this.isClosed || this.reconnectTimer || this.symbols.length === 0) {
            return;
        }

        const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        logger.warn(TAG, `WebSocket disconnected. Reconnecting in ${delay} ms.`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.openSocket()
                .then(() => this.sendSubscription('subscribe', this.symbols))
                .catch((error: any) => {
                    logger.warn(TAG, `Reconnect failed: ${error.message}`);
                    this.scheduleReconnect();
                });
        }, delay);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 'ping' }));
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private markAllUnsynced(): void {
        for (const symbol of this.symbols) {
            this.store.markUnsynced(symbol);
        }
    }

    private emit(symbol: string): void {
        for (const listener of this.listeners) {
            listener(symbol);
        }
    }

    private parseLevels(levels: BybitDepthLevel[]): [number, number][] {
        return levels.map(([price, amount]) => [Number(price), Number(amount)]);
    }

    private normalizeDepthLimit(limit: number): number {
        const allowed = [1, 50, 200, 1000];
        return allowed.find(value => limit <= value) ?? 1000;
    }

    private chunkTopics(topics: string[]): string[][] {
        const chunks: string[][] = [];
        let current: string[] = [];
        let currentLength = 0;

        for (const topic of topics) {
            if (current.length > 0 && currentLength + topic.length > MAX_SUBSCRIBE_CHARS) {
                chunks.push(current);
                current = [];
                currentLength = 0;
            }

            current.push(topic);
            currentLength += topic.length;
        }

        if (current.length > 0) {
            chunks.push(current);
        }

        return chunks;
    }
}

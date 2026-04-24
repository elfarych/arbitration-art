import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { config } from '../../config.js';
import type { OrderBookProvider, OrderBookSnapshot } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { gateToUnified, unifiedToGate } from '../symbols.js';
import { OrderBookStore } from './orderbook-store.js';

const TAG = 'GateOrderBookWs';
const SETTLE = 'usdt';
const CHANNEL = 'futures.order_book_update';
const FREQUENCY = '100ms';
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_BUFFERED_EVENTS = 2000;
const MAX_STALE_MS = 10_000;

interface GateContract {
    name: string;
    type?: string;
    quanto_multiplier?: string | number;
}

interface GateOrderBookLevel {
    p: string;
    s: string | number;
}

interface GateRestOrderBook {
    id?: string | number;
    current?: string | number;
    update_time?: string | number;
    bids?: GateOrderBookLevel[];
    asks?: GateOrderBookLevel[];
}

interface GateOrderBookUpdate {
    t?: number;
    s: string;
    U?: string | number;
    u?: string | number;
    b?: GateOrderBookLevel[];
    a?: GateOrderBookLevel[];
    full?: boolean;
}

interface GateWsMessage {
    time?: number;
    time_ms?: number;
    channel?: string;
    event?: string;
    error?: {
        code?: number;
        message?: string;
    } | null;
    result?: unknown;
    type?: string;
    msg?: string;
}

export class GateOrderBookProvider implements OrderBookProvider {
    public readonly exchange = 'Gate';

    private readonly httpClient: AxiosInstance;
    private readonly store: OrderBookStore;
    private readonly useTestnet: boolean;
    private readonly depthLimit: number;
    private readonly multipliers = new Map<string, number>();
    private ws: WebSocket | null = null;
    private symbols: string[] = [];
    private listeners = new Set<(symbol: string) => void>();
    private buffers = new Map<string, GateOrderBookUpdate[]>();
    private resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private staleSymbols = new Set<string>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts = 0;
    private isClosed = false;

    constructor(options: { useTestnet?: boolean; depthLimit?: number } = {}) {
        this.useTestnet = options.useTestnet ?? config.useTestnet;
        this.depthLimit = this.normalizeDepthLimit(options.depthLimit ?? config.orderbookLimit);
        this.store = new OrderBookStore(this.depthLimit);
        this.httpClient = axios.create({
            baseURL: this.useTestnet
                ? 'https://fx-api-testnet.gateio.ws/api/v4'
                : 'https://fx-api.gateio.ws/api/v4',
            timeout: 10000,
        });
    }

    async connect(): Promise<void> {
        this.isClosed = false;
        await this.loadContractMultipliers();
    }

    async subscribe(symbols: string[]): Promise<void> {
        const uniqueSymbols = [...new Set(symbols)];
        const newSymbols = uniqueSymbols.filter(symbol => !this.symbols.includes(symbol));
        if (newSymbols.length === 0) {
            return;
        }

        await this.loadContractMultipliers(newSymbols);
        this.symbols = [...this.symbols, ...newSymbols];
        for (const symbol of newSymbols) {
            this.buffers.set(symbol, []);
        }

        await this.openSocket();
        this.sendSubscription('subscribe', newSymbols);
        await this.initializeSymbols(newSymbols);
    }

    async unsubscribe(symbols: string[]): Promise<void> {
        const removed = new Set(symbols);
        this.symbols = this.symbols.filter(symbol => !removed.has(symbol));

        for (const symbol of symbols) {
            this.buffers.delete(symbol);
            this.staleSymbols.delete(symbol);
            const timer = this.resyncTimers.get(symbol);
            if (timer) {
                clearTimeout(timer);
                this.resyncTimers.delete(symbol);
            }
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
                logger.warn(TAG, `Orderbook for ${symbol} is stale; blocking trading until the next Gate update.`);
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

        for (const timer of this.resyncTimers.values()) {
            clearTimeout(timer);
        }
        this.resyncTimers.clear();
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
            ? 'wss://ws-testnet.gate.com/v4/ws/futures/usdt'
            : 'wss://fx-ws.gateio.ws/v4/ws/usdt';

        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(url, {
                headers: {
                    'X-Gate-Size-Decimal': '1',
                },
            });
            this.ws = socket;

            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error('Gate websocket connection timeout'));
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
                logger.info(TAG, `Connected to Gate USDT futures orderbook stream for ${this.symbols.length} symbols.`);
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
            const message = JSON.parse(raw.toString()) as GateWsMessage;

            if (message.channel === 'futures.pong') {
                return;
            }

            if (message.type === 'upgrade') {
                logger.warn(TAG, `Gate service upgrade notice: ${message.msg || 'reconnect requested'}`);
                this.ws?.close();
                return;
            }

            if (message.error) {
                logger.warn(TAG, `Gate websocket command failed: ${message.error.message || JSON.stringify(message.error)}`);
                return;
            }

            if (message.channel !== CHANNEL || message.event !== 'update' || !this.isOrderBookUpdate(message.result)) {
                return;
            }

            const update = message.result;
            const symbol = gateToUnified(update.s);
            if (!this.symbols.includes(symbol)) {
                return;
            }

            if (update.full === true) {
                this.applyFullUpdate(symbol, update, message.time_ms ?? message.time ?? null);
                return;
            }

            const snapshot = this.store.getOrderBook(symbol);
            if (!snapshot?.isSynced) {
                this.bufferEvent(symbol, update);
                return;
            }

            this.applyLiveUpdate(symbol, update);
        } catch (error: any) {
            logger.warn(TAG, `Failed to parse Gate orderbook message: ${error.message}`);
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
        const gateSymbol = unifiedToGate(symbol);
        try {
            const response = await this.httpClient.get<GateRestOrderBook>(`/futures/${SETTLE}/order_book`, {
                params: {
                    contract: gateSymbol,
                    interval: '0',
                    limit: this.depthLimit,
                    with_id: true,
                },
            });

            const snapshot = response.data;
            const baseId = Number(snapshot.id);
            if (!Number.isFinite(baseId)) {
                throw new Error(`Gate REST snapshot for ${symbol} does not include orderbook id`);
            }

            this.store.applySnapshot(
                symbol,
                this.parseLevels(symbol, snapshot.bids ?? []),
                this.parseLevels(symbol, snapshot.asks ?? []),
                baseId,
                Number(snapshot.current ?? snapshot.update_time) || null,
            );

            const buffered = this.buffers.get(symbol) ?? [];
            this.buffers.set(symbol, []);
            if (!this.applyBufferedEvents(symbol, baseId, buffered)) {
                this.scheduleSymbolResync(symbol, 'buffer did not bridge REST snapshot');
                return;
            }

            this.staleSymbols.delete(symbol);
            this.emit(symbol);
        } catch (error: any) {
            this.store.markUnsynced(symbol);
            logger.warn(TAG, `Failed to initialize ${symbol} orderbook: ${error.message}`);
            this.scheduleSymbolResync(symbol, 'snapshot request failed');
        }
    }

    private applyFullUpdate(symbol: string, update: GateOrderBookUpdate, timestamp: number | null): void {
        const range = this.getUpdateRange(update);
        this.store.applySnapshot(
            symbol,
            this.parseLevels(symbol, update.b ?? []),
            this.parseLevels(symbol, update.a ?? []),
            range?.u ?? range?.U ?? null,
            update.t ?? timestamp,
        );
        this.buffers.set(symbol, []);
        this.staleSymbols.delete(symbol);
        this.emit(symbol);
    }

    private applyBufferedEvents(symbol: string, baseId: number, events: GateOrderBookUpdate[]): boolean {
        const targetUpdateId = baseId + 1;
        const candidates = events
            .filter(event => {
                const range = this.getUpdateRange(event);
                return range !== null && range.u >= targetUpdateId;
            })
            .sort((left, right) => Number(left.U) - Number(right.U));

        if (candidates.length === 0) {
            return true;
        }

        const firstIndex = candidates.findIndex(event => {
            const range = this.getUpdateRange(event);
            return range !== null && range.U <= targetUpdateId && range.u >= targetUpdateId;
        });
        if (firstIndex === -1) {
            return false;
        }

        let previousUpdateId = baseId;
        for (const event of candidates.slice(firstIndex)) {
            const range = this.getUpdateRange(event);
            if (!range) {
                return false;
            }

            if (range.u <= previousUpdateId) {
                continue;
            }

            if (range.U > previousUpdateId + 1) {
                return false;
            }

            this.applyDelta(symbol, event, range.u);
            previousUpdateId = range.u;
        }

        return true;
    }

    private applyLiveUpdate(symbol: string, update: GateOrderBookUpdate): void {
        const range = this.getUpdateRange(update);
        if (!range) {
            this.scheduleSymbolResync(symbol, 'update did not include valid U/u sequence');
            return;
        }

        const previousUpdateId = Number(this.store.getSequence(symbol));
        if (!Number.isFinite(previousUpdateId)) {
            this.scheduleSymbolResync(symbol, 'local sequence is missing');
            return;
        }

        if (range.u <= previousUpdateId) {
            return;
        }

        if (range.U > previousUpdateId + 1) {
            this.bufferEvent(symbol, update);
            this.scheduleSymbolResync(symbol, `sequence gap: U=${range.U}, local=${previousUpdateId}`);
            return;
        }

        this.applyDelta(symbol, update, range.u);
        this.emit(symbol);
    }

    private applyDelta(symbol: string, update: GateOrderBookUpdate, sequence: number): void {
        this.store.applyAbsoluteDelta(
            symbol,
            this.parseLevels(symbol, update.b ?? []),
            this.parseLevels(symbol, update.a ?? []),
            sequence,
            update.t ?? null,
        );
        this.staleSymbols.delete(symbol);
    }

    private sendSubscription(op: 'subscribe' | 'unsubscribe', symbols: string[]): void {
        const socket = this.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN || symbols.length === 0) {
            return;
        }

        for (const symbol of symbols) {
            const payload = op === 'subscribe'
                ? [unifiedToGate(symbol), FREQUENCY, String(this.depthLimit)]
                : [unifiedToGate(symbol), FREQUENCY];

            socket.send(JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                channel: CHANNEL,
                event: op,
                payload,
            }));
        }
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
        if (this.isClosed || this.reconnectTimer || this.symbols.length === 0) {
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
                .then(() => {
                    this.sendSubscription('subscribe', this.symbols);
                    return this.initializeSymbols(this.symbols);
                })
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
                this.ws.send(JSON.stringify({
                    time: Math.floor(Date.now() / 1000),
                    channel: 'futures.ping',
                }));
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

    private bufferEvent(symbol: string, event: GateOrderBookUpdate): void {
        const buffer = this.buffers.get(symbol) ?? [];
        buffer.push(event);
        if (buffer.length > MAX_BUFFERED_EVENTS) {
            buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
        }
        this.buffers.set(symbol, buffer);
    }

    private async loadContractMultipliers(symbols?: string[]): Promise<void> {
        const required = symbols?.map(symbol => unifiedToGate(symbol)) ?? [];
        if (this.multipliers.size > 0 && required.every(symbol => this.multipliers.has(symbol))) {
            return;
        }

        const response = await this.httpClient.get<GateContract[]>(`/futures/${SETTLE}/contracts`);
        this.multipliers.clear();

        for (const contract of response.data) {
            const multiplier = Number(contract.quanto_multiplier);
            if (
                contract.type === 'direct'
                && contract.name.endsWith('_USDT')
                && Number.isFinite(multiplier)
                && multiplier > 0
            ) {
                this.multipliers.set(contract.name, multiplier);
            }
        }

        const missing = required.filter(symbol => !this.multipliers.has(symbol));
        if (missing.length > 0) {
            throw new Error(`Gate contract metadata missing for: ${missing.join(', ')}`);
        }
    }

    private parseLevels(symbol: string, levels: GateOrderBookLevel[]): [number, number][] {
        const multiplier = this.getMultiplier(symbol);
        return levels.map(level => [
            Number(level.p),
            Number(level.s) * multiplier,
        ]);
    }

    private getMultiplier(symbol: string): number {
        const gateSymbol = unifiedToGate(symbol);
        const multiplier = this.multipliers.get(gateSymbol);
        if (!Number.isFinite(multiplier) || multiplier === undefined || multiplier <= 0) {
            throw new Error(`Gate quanto_multiplier is missing for ${symbol}`);
        }
        return multiplier;
    }

    private getUpdateRange(update: GateOrderBookUpdate): { U: number; u: number } | null {
        const first = Number(update.U);
        const last = Number(update.u);
        if (!Number.isFinite(first) || !Number.isFinite(last)) {
            return null;
        }

        return { U: first, u: last };
    }

    private isOrderBookUpdate(result: unknown): result is GateOrderBookUpdate {
        if (!result || typeof result !== 'object') {
            return false;
        }

        const candidate = result as Partial<GateOrderBookUpdate>;
        return typeof candidate.s === 'string';
    }

    private emit(symbol: string): void {
        for (const listener of this.listeners) {
            listener(symbol);
        }
    }

    private normalizeDepthLimit(limit: number): number {
        if (limit <= 20) {
            return 20;
        }
        if (limit <= 50) {
            return 50;
        }
        return 100;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

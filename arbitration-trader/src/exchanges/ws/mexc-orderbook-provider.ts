import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { config } from '../../config.js';
import type { OrderBookProvider, OrderBookSnapshot } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { mexcToUnified, unifiedToMexc } from '../symbols.js';
import { OrderBookStore } from './orderbook-store.js';

const TAG = 'MexcOrderBookWs';
const BASE_URL = 'https://contract.mexc.com';
const WS_URL = 'wss://contract.mexc.com/edge';
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_BUFFERED_EVENTS = 2000;
const MAX_STALE_MS = 10_000;

type MexcDepthLevel = [number | string, number | string, (number | string)?];

interface MexcResponse<T> {
    success: boolean;
    code: number;
    message?: string;
    data: T;
}

interface MexcContract {
    symbol: string;
    quoteCoin?: string;
    settleCoin?: string;
    contractSize?: string | number;
    state?: number;
    apiAllowed?: boolean;
}

interface MexcRestOrderBook {
    asks?: MexcDepthLevel[];
    bids?: MexcDepthLevel[];
    version?: string | number;
    timestamp?: string | number;
}

type MexcRestOrderBookPayload = MexcRestOrderBook | MexcResponse<MexcRestOrderBook>;

interface MexcDepthUpdate {
    asks?: MexcDepthLevel[];
    bids?: MexcDepthLevel[];
    version?: string | number;
}

interface MexcWsMessage {
    channel?: string;
    data?: unknown;
    symbol?: string;
    ts?: string | number;
}

export class MexcOrderBookProvider implements OrderBookProvider {
    public readonly exchange = 'Mexc';

    private readonly httpClient: AxiosInstance;
    private readonly store: OrderBookStore;
    private readonly useTestnet: boolean;
    private readonly depthLimit: number;
    private readonly contractSizes = new Map<string, number>();
    private ws: WebSocket | null = null;
    private symbols: string[] = [];
    private listeners = new Set<(symbol: string) => void>();
    private buffers = new Map<string, MexcDepthUpdate[]>();
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
            baseURL: BASE_URL,
            timeout: 10000,
        });
    }

    async connect(): Promise<void> {
        if (this.useTestnet) {
            throw new Error('MEXC Futures testnet WebSocket is not configured in this project.');
        }

        this.isClosed = false;
        await this.loadContractSizes();
    }

    async subscribe(symbols: string[]): Promise<void> {
        const uniqueSymbols = [...new Set(symbols)];
        const newSymbols = uniqueSymbols.filter(symbol => !this.symbols.includes(symbol));
        if (newSymbols.length === 0) {
            return;
        }

        await this.loadContractSizes(newSymbols);
        this.symbols = [...this.symbols, ...newSymbols];
        for (const symbol of newSymbols) {
            this.buffers.set(symbol, []);
        }

        await this.openSocket();
        this.sendSubscription('sub.depth', newSymbols);
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
            this.sendSubscription('unsub.depth', symbols);
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
                logger.warn(TAG, `Orderbook for ${symbol} is stale; blocking trading until the next MEXC depth update.`);
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

        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(WS_URL);
            this.ws = socket;

            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error('MEXC websocket connection timeout'));
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
                logger.info(TAG, `Connected to MEXC contract depth stream for ${this.symbols.length} symbols.`);
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
            const message = JSON.parse(raw.toString()) as MexcWsMessage;

            if (message.channel === 'pong') {
                return;
            }

            if (message.channel === 'rs.error') {
                logger.warn(TAG, `MEXC websocket command failed: ${JSON.stringify(message.data)}`);
                return;
            }

            if (message.channel?.startsWith('rs.')) {
                return;
            }

            if (message.channel !== 'push.depth' || !this.isDepthUpdate(message.data) || !message.symbol) {
                return;
            }

            const symbol = mexcToUnified(message.symbol);
            if (!this.symbols.includes(symbol)) {
                return;
            }

            const update = message.data;
            const snapshot = this.store.getOrderBook(symbol);
            if (!snapshot?.isSynced) {
                this.bufferEvent(symbol, update);
                return;
            }

            this.applyLiveUpdate(symbol, update, Number(message.ts) || null);
        } catch (error: any) {
            logger.warn(TAG, `Failed to parse MEXC depth message: ${error.message}`);
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
        const mexcSymbol = unifiedToMexc(symbol);
        try {
            const response = await this.httpClient.get<MexcRestOrderBookPayload>(`/api/v1/contract/depth/${mexcSymbol}`, {
                params: {
                    limit: this.depthLimit,
                },
            });

            const snapshot = this.unwrapRestOrderBook(response.data);
            const baseVersion = Number(snapshot.version);
            if (!Number.isFinite(baseVersion)) {
                throw new Error(`MEXC REST snapshot for ${symbol} does not include depth version`);
            }

            this.store.applySnapshot(
                symbol,
                this.parseLevels(symbol, snapshot.bids ?? []),
                this.parseLevels(symbol, snapshot.asks ?? []),
                baseVersion,
                Number(snapshot.timestamp) || null,
            );

            const buffered = this.buffers.get(symbol) ?? [];
            this.buffers.set(symbol, []);
            if (!this.applyBufferedEvents(symbol, baseVersion, buffered)) {
                this.scheduleSymbolResync(symbol, 'buffer did not continue REST snapshot version');
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

    private applyBufferedEvents(symbol: string, baseVersion: number, events: MexcDepthUpdate[]): boolean {
        const candidates = events
            .filter(event => Number(event.version) > baseVersion)
            .sort((left, right) => Number(left.version) - Number(right.version));

        if (candidates.length === 0) {
            return true;
        }

        let expectedVersion = baseVersion + 1;
        for (const event of candidates) {
            const version = Number(event.version);
            if (!Number.isFinite(version)) {
                return false;
            }

            if (version !== expectedVersion) {
                return false;
            }

            this.applyDelta(symbol, event, version, null);
            expectedVersion = version + 1;
        }

        return true;
    }

    private applyLiveUpdate(symbol: string, update: MexcDepthUpdate, timestamp: number | null): void {
        const version = Number(update.version);
        if (!Number.isFinite(version)) {
            this.scheduleSymbolResync(symbol, 'update did not include valid version');
            return;
        }

        const previousVersion = Number(this.store.getSequence(symbol));
        if (!Number.isFinite(previousVersion)) {
            this.scheduleSymbolResync(symbol, 'local sequence is missing');
            return;
        }

        if (version <= previousVersion) {
            return;
        }

        if (version !== previousVersion + 1) {
            this.bufferEvent(symbol, update);
            this.scheduleSymbolResync(symbol, `sequence gap: version=${version}, local=${previousVersion}`);
            return;
        }

        this.applyDelta(symbol, update, version, timestamp);
        this.emit(symbol);
    }

    private applyDelta(symbol: string, update: MexcDepthUpdate, sequence: number, timestamp: number | null): void {
        this.store.applyAbsoluteDelta(
            symbol,
            this.parseLevels(symbol, update.bids ?? []),
            this.parseLevels(symbol, update.asks ?? []),
            sequence,
            timestamp,
        );
        this.staleSymbols.delete(symbol);
    }

    private sendSubscription(method: 'sub.depth' | 'unsub.depth', symbols: string[]): void {
        const socket = this.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN || symbols.length === 0) {
            return;
        }

        for (const symbol of symbols) {
            socket.send(JSON.stringify({
                method,
                param: {
                    symbol: unifiedToMexc(symbol),
                    ...(method === 'sub.depth' ? { compress: false } : {}),
                },
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
                    this.sendSubscription('sub.depth', this.symbols);
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
                this.ws.send(JSON.stringify({ method: 'ping' }));
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

    private bufferEvent(symbol: string, event: MexcDepthUpdate): void {
        const buffer = this.buffers.get(symbol) ?? [];
        buffer.push(event);
        if (buffer.length > MAX_BUFFERED_EVENTS) {
            buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
        }
        this.buffers.set(symbol, buffer);
    }

    private async loadContractSizes(symbols?: string[]): Promise<void> {
        const required = symbols?.map(symbol => unifiedToMexc(symbol)) ?? [];
        if (this.contractSizes.size > 0 && required.every(symbol => this.contractSizes.has(symbol))) {
            return;
        }

        const response = await this.httpClient.get<MexcResponse<MexcContract[]>>('/api/v1/contract/detail');
        const contracts = response.data.success === true ? response.data.data : [];
        this.contractSizes.clear();

        for (const contract of contracts) {
            const contractSize = Number(contract.contractSize);
            if (
                contract.symbol.endsWith('_USDT')
                && contract.quoteCoin === 'USDT'
                && contract.settleCoin === 'USDT'
                && contract.state === 0
                && contract.apiAllowed !== false
                && Number.isFinite(contractSize)
                && contractSize > 0
            ) {
                this.contractSizes.set(contract.symbol, contractSize);
            }
        }

        const missing = required.filter(symbol => !this.contractSizes.has(symbol));
        if (missing.length > 0) {
            throw new Error(`MEXC contract metadata missing for: ${missing.join(', ')}`);
        }
    }

    private parseLevels(symbol: string, levels: MexcDepthLevel[]): [number, number][] {
        const contractSize = this.getContractSize(symbol);
        return levels.map(level => [
            Number(level[0]),
            Number(level[1]) * contractSize,
        ]);
    }

    private getContractSize(symbol: string): number {
        const mexcSymbol = unifiedToMexc(symbol);
        const contractSize = this.contractSizes.get(mexcSymbol);
        if (!Number.isFinite(contractSize) || contractSize === undefined || contractSize <= 0) {
            throw new Error(`MEXC contractSize is missing for ${symbol}`);
        }

        return contractSize;
    }

    private isDepthUpdate(data: unknown): data is MexcDepthUpdate {
        if (!data || typeof data !== 'object') {
            return false;
        }

        const candidate = data as Partial<MexcDepthUpdate>;
        return candidate.version !== undefined;
    }

    private unwrapRestOrderBook(payload: MexcRestOrderBookPayload): MexcRestOrderBook {
        if (
            payload
            && typeof payload === 'object'
            && 'success' in payload
            && 'code' in payload
        ) {
            if (payload.success !== true || Number(payload.code) !== 0) {
                throw new Error(`MEXC depth snapshot failed: ${payload.message || payload.code}`);
            }

            return payload.data;
        }

        return payload;
    }

    private emit(symbol: string): void {
        for (const listener of this.listeners) {
            listener(symbol);
        }
    }

    private normalizeDepthLimit(limit: number): number {
        const allowed = [5, 10, 20, 50, 100];
        return allowed.find(value => limit <= value) ?? 100;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

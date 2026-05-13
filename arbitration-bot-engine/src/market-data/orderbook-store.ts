import { EventEmitter } from 'node:events';

/**
 * Single orderbook snapshot stored in memory.
 *
 * `bids` are sorted descending by price, `asks` ascending — matching the
 * conventions used by `calculateVWAP` and the spread math. Each level is a
 * `[price, qty]` tuple to keep allocations low on the hot path.
 */
export interface OrderBookSnapshot {
    exchange: string;
    symbol: string;
    bids: [number, number][];
    asks: [number, number][];
    /** Exchange-reported timestamp if available. */
    exchangeTimestamp: number | null;
    /** Local arrival time, set by the native WS client right after parsing. */
    localTimestamp: number;
    /** Optional sequence/update id for diagnostics. */
    sequence: number | string | null;
}

type UpdateListener = (exchange: string, symbol: string, snapshot: OrderBookSnapshot) => void;

/**
 * Hot-path in-memory orderbook cache used by BotTrader.
 *
 * Native market WS clients call `set()` after every parsed update. BotTrader
 * either reads the latest snapshot via `get()` (when checking spreads on its
 * own tick) or subscribes via `onUpdate()` to receive events the moment a new
 * snapshot arrives. The store does no parsing or merging itself — clients are
 * responsible for normalising bid/ask arrays before calling `set()`.
 */
export class OrderBookStore {
    private readonly snapshots = new Map<string, OrderBookSnapshot>();
    private readonly emitter = new EventEmitter();

    constructor() {
        // Multiple bot traders may subscribe to the same store; lift the
        // default 10-listener safety net so legitimate fan-out does not warn.
        this.emitter.setMaxListeners(0);
    }

    set(snapshot: OrderBookSnapshot): void {
        this.snapshots.set(this.key(snapshot.exchange, snapshot.symbol), snapshot);
        this.emitter.emit('update', snapshot.exchange, snapshot.symbol, snapshot);
    }

    get(exchange: string, symbol: string): OrderBookSnapshot | null {
        return this.snapshots.get(this.key(exchange, symbol)) ?? null;
    }

    /**
     * Subscribe to every snapshot update. The returned function unsubscribes.
     * Listeners should filter by `exchange`/`symbol` themselves.
     */
    onUpdate(listener: UpdateListener): () => void {
        this.emitter.on('update', listener);
        return () => this.emitter.off('update', listener);
    }

    /** Remove all snapshots for the given exchange/symbol pair. */
    clear(exchange: string, symbol: string): void {
        this.snapshots.delete(this.key(exchange, symbol));
    }

    private key(exchange: string, symbol: string): string {
        return `${exchange}:${symbol}`;
    }
}

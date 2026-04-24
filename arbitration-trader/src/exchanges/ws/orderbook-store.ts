import type { OrderBookSnapshot } from '../../types/index.js';

interface StoredOrderBook {
    symbol: string;
    bids: Map<number, number>;
    asks: Map<number, number>;
    cachedBids: [number, number][];
    cachedAsks: [number, number][];
    exchangeTimestamp: number | null;
    localTimestamp: number;
    sequence: string | number | null;
    isSynced: boolean;
}

export class OrderBookStore {
    private books = new Map<string, StoredOrderBook>();

    constructor(private readonly depthLimit: number) {}

    applySnapshot(
        symbol: string,
        bids: [number, number][],
        asks: [number, number][],
        sequence: string | number | null,
        exchangeTimestamp: number | null,
    ): void {
        const bidMap = this.toLevels(bids);
        const askMap = this.toLevels(asks);
        this.books.set(symbol, {
            symbol,
            bids: bidMap,
            asks: askMap,
            cachedBids: this.sortedLevels(bidMap, 'bid'),
            cachedAsks: this.sortedLevels(askMap, 'ask'),
            exchangeTimestamp,
            localTimestamp: Date.now(),
            sequence,
            isSynced: true,
        });
    }

    applyAbsoluteDelta(
        symbol: string,
        bids: [number, number][],
        asks: [number, number][],
        sequence: string | number | null,
        exchangeTimestamp: number | null,
    ): void {
        const book = this.books.get(symbol);
        if (!book) {
            return;
        }

        this.applyLevels(book.bids, bids);
        this.applyLevels(book.asks, asks);
        this.prune(book.bids, 'bid');
        this.prune(book.asks, 'ask');
        book.cachedBids = this.sortedLevels(book.bids, 'bid');
        book.cachedAsks = this.sortedLevels(book.asks, 'ask');
        book.sequence = sequence;
        book.exchangeTimestamp = exchangeTimestamp;
        book.localTimestamp = Date.now();
        book.isSynced = true;
    }

    markUnsynced(symbol: string): void {
        const book = this.books.get(symbol);
        if (book) {
            book.isSynced = false;
            book.localTimestamp = Date.now();
        }
    }

    getSequence(symbol: string): string | number | null {
        return this.books.get(symbol)?.sequence ?? null;
    }

    getOrderBook(symbol: string): OrderBookSnapshot | null {
        const book = this.books.get(symbol);
        if (!book) {
            return null;
        }

        return {
            symbol,
            bids: book.cachedBids,
            asks: book.cachedAsks,
            exchangeTimestamp: book.exchangeTimestamp,
            localTimestamp: book.localTimestamp,
            sequence: book.sequence,
            isSynced: book.isSynced,
        };
    }

    private toLevels(levels: [number, number][]): Map<number, number> {
        const result = new Map<number, number>();
        for (const [price, amount] of levels.slice(0, this.depthLimit)) {
            if (Number.isFinite(price) && Number.isFinite(amount) && amount > 0) {
                result.set(price, amount);
            }
        }
        return result;
    }

    private applyLevels(target: Map<number, number>, levels: [number, number][]): void {
        for (const [price, amount] of levels) {
            if (!Number.isFinite(price) || !Number.isFinite(amount)) {
                continue;
            }

            if (amount === 0) {
                target.delete(price);
                continue;
            }

            target.set(price, amount);
        }
    }

    private prune(target: Map<number, number>, side: 'bid' | 'ask'): void {
        if (target.size <= this.depthLimit * 2) {
            return;
        }

        const keep = new Set(this.sortedLevels(target, side).map(([price]) => price));
        for (const price of target.keys()) {
            if (!keep.has(price)) {
                target.delete(price);
            }
        }
    }

    private sortedLevels(target: Map<number, number>, side: 'bid' | 'ask'): [number, number][] {
        return [...target.entries()]
            .filter(([, amount]) => amount > 0)
            .sort(([left], [right]) => side === 'bid' ? right - left : left - right)
            .slice(0, this.depthLimit);
    }
}

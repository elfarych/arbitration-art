import { EventEmitter } from 'node:events';
import type { ExchangeName } from '../config.js';
import type { OrderBookSnapshot } from '../exchanges/exchange-types.js';

type UpdateListener = (exchange: ExchangeName, symbol: string, snapshot: OrderBookSnapshot) => void;

export class OrderBookStore {
    private readonly snapshots = new Map<string, OrderBookSnapshot>();
    private readonly emitter = new EventEmitter();

    set(snapshot: OrderBookSnapshot): void {
        this.snapshots.set(this.key(snapshot.exchange, snapshot.symbol), snapshot);
        this.emitter.emit('update', snapshot.exchange, snapshot.symbol, snapshot);
    }

    get(exchange: ExchangeName, symbol: string): OrderBookSnapshot | null {
        return this.snapshots.get(this.key(exchange, symbol)) ?? null;
    }

    getPair(
        primaryExchange: ExchangeName,
        secondaryExchange: ExchangeName,
        symbol: string,
    ): { primary: OrderBookSnapshot; secondary: OrderBookSnapshot } | null {
        const primary = this.get(primaryExchange, symbol);
        const secondary = this.get(secondaryExchange, symbol);
        if (!primary || !secondary) {
            return null;
        }
        return { primary, secondary };
    }

    onUpdate(listener: UpdateListener): () => void {
        this.emitter.on('update', listener);
        return () => this.emitter.off('update', listener);
    }

    symbols(exchange: ExchangeName): string[] {
        const prefix = `${exchange}:`;
        return [...this.snapshots.keys()]
            .filter(key => key.startsWith(prefix))
            .map(key => key.slice(prefix.length));
    }

    private key(exchange: ExchangeName, symbol: string): string {
        return `${exchange}:${symbol}`;
    }
}

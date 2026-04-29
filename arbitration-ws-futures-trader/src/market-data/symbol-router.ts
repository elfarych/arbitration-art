import type { ExchangeName, NormalizedRuntimeConfig } from '../config.js';
import { OrderBookStore } from './orderbook-store.js';

export type SymbolUpdateHandler = (symbol: string, sourceExchange: ExchangeName) => void;

export class SymbolRouter {
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly store: OrderBookStore,
        private readonly runtime: NormalizedRuntimeConfig,
        private readonly symbols: Set<string>,
        private readonly handler: SymbolUpdateHandler,
    ) {}

    start(): void {
        if (this.unsubscribe) {
            return;
        }

        this.unsubscribe = this.store.onUpdate((exchange, symbol) => {
            if (exchange !== this.runtime.primaryExchange && exchange !== this.runtime.secondaryExchange) {
                return;
            }
            if (!this.symbols.has(symbol)) {
                return;
            }
            this.handler(symbol, exchange);
        });
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}

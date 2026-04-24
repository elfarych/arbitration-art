import { config } from '../../config.js';
import type { OrderBookProvider } from '../../types/index.js';
import { BinanceOrderBookProvider } from './binance-orderbook-provider.js';
import { BybitOrderBookProvider } from './bybit-orderbook-provider.js';
import { GateOrderBookProvider } from './gate-orderbook-provider.js';
import { MexcOrderBookProvider } from './mexc-orderbook-provider.js';

export function createOrderBookProvider(name: string): OrderBookProvider {
    switch (name.toLowerCase()) {
        case 'binance':
            return new BinanceOrderBookProvider({
                useTestnet: config.useTestnet,
                depthLimit: config.orderbookLimit,
            });
        case 'bybit':
            return new BybitOrderBookProvider({
                useTestnet: config.useTestnet,
                depthLimit: config.orderbookLimit,
            });
        case 'gate':
            return new GateOrderBookProvider({
                useTestnet: config.useTestnet,
                depthLimit: config.orderbookLimit,
            });
        case 'mexc':
            return new MexcOrderBookProvider({
                useTestnet: config.useTestnet,
                depthLimit: config.orderbookLimit,
            });
        default:
            throw new Error(`Orderbook provider not implemented for ${name}`);
    }
}

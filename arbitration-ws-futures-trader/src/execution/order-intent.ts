import type { ExchangeName } from '../config.js';
import type { OrderExecution, OrderIntent, OrderSide, TradeDirection } from '../exchanges/exchange-types.js';
import { normalizeClientOrderId, unifiedToExchangeSymbol } from '../exchanges/symbols.js';

export interface TwoLegOrderIntents {
    primary: OrderIntent;
    secondary: OrderIntent;
}

export function createOpenIntents(params: {
    localTradeId: string;
    primaryExchange: ExchangeName;
    secondaryExchange: ExchangeName;
    symbol: string;
    direction: TradeDirection;
    quantity: number;
}): TwoLegOrderIntents {
    const primarySide: OrderSide = params.direction === 'buy' ? 'buy' : 'sell';
    const secondarySide: OrderSide = params.direction === 'buy' ? 'sell' : 'buy';
    return createTwoLegIntents({ ...params, primarySide, secondarySide, reduceOnly: false, suffix: 'o' });
}

export function createCloseIntents(params: {
    localTradeId: string;
    primaryExchange: ExchangeName;
    secondaryExchange: ExchangeName;
    symbol: string;
    direction: TradeDirection;
    quantity: number;
}): TwoLegOrderIntents {
    const primarySide: OrderSide = params.direction === 'buy' ? 'sell' : 'buy';
    const secondarySide: OrderSide = params.direction === 'buy' ? 'buy' : 'sell';
    return createTwoLegIntents({ ...params, primarySide, secondarySide, reduceOnly: true, suffix: 'c' });
}

export function executionPriceOrFallback(execution: OrderExecution, fallback: number): number {
    return execution.avgPrice > 0 ? execution.avgPrice : fallback;
}

function createTwoLegIntents(params: {
    localTradeId: string;
    primaryExchange: ExchangeName;
    secondaryExchange: ExchangeName;
    symbol: string;
    quantity: number;
    primarySide: OrderSide;
    secondarySide: OrderSide;
    reduceOnly: boolean;
    suffix: string;
}): TwoLegOrderIntents {
    const createdAt = Date.now();
    const exchangeSymbol = unifiedToExchangeSymbol(params.symbol);
    return {
        primary: {
            intentId: `${params.localTradeId}:primary:${params.suffix}`,
            clientOrderId: normalizeClientOrderId('aaw', `${params.suffix}p${params.localTradeId}`),
            exchange: params.primaryExchange,
            symbol: exchangeSymbol,
            side: params.primarySide,
            quantity: params.quantity,
            reduceOnly: params.reduceOnly,
            createdAt,
        },
        secondary: {
            intentId: `${params.localTradeId}:secondary:${params.suffix}`,
            clientOrderId: normalizeClientOrderId('aaw', `${params.suffix}s${params.localTradeId}`),
            exchange: params.secondaryExchange,
            symbol: exchangeSymbol,
            side: params.secondarySide,
            quantity: params.quantity,
            reduceOnly: params.reduceOnly,
            createdAt,
        },
    };
}

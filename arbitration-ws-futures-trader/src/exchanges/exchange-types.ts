import type { ExchangeName } from '../config.js';

export type TradeDirection = 'buy' | 'sell';
export type OrderSide = 'buy' | 'sell';
export type SymbolStateStatus =
    | 'idle'
    | 'opening'
    | 'open'
    | 'closing'
    | 'close_pending_persistence'
    | 'error_exposure'
    | 'paused';

export interface OrderBookSnapshot {
    exchange: ExchangeName;
    symbol: string;
    bids: [number, number][];
    asks: [number, number][];
    exchangeTimestamp: number | null;
    localTimestamp: number;
    sequence: string | number | null;
}

export interface SymbolMarketInfo {
    symbol: string;
    exchange: ExchangeName;
    exchangeSymbol: string;
    minQty: number;
    stepSize: number;
    minNotional: number;
    quoteVolume: number;
    priceChangePercent24h: number;
}

export interface UnifiedMarketInfo {
    symbol: string;
    stepSize: number;
    minQty: number;
    minNotional: number;
    tradeAmount: number;
}

export interface OrderIntent {
    intentId: string;
    clientOrderId: string;
    exchange: ExchangeName;
    symbol: string;
    side: OrderSide;
    quantity: number;
    reduceOnly: boolean;
    createdAt: number;
}

export interface OrderExecution {
    exchange: ExchangeName;
    symbol: string;
    orderId: string;
    clientOrderId: string;
    side: OrderSide;
    quantity: number;
    avgPrice: number;
    filledQty: number;
    commission: number;
    commissionAsset: string;
    acknowledgedAt: number;
    filledAt: number | null;
    raw: unknown;
}

export interface TradeWsClient {
    readonly exchange: ExchangeName;
    connect(): Promise<void>;
    close(): Promise<void>;
    isReady(): boolean;
    submitMarketOrder(intent: OrderIntent): Promise<OrderExecution>;
    onReadyChange(listener: (ready: boolean) => void): () => void;
}

export interface MarketWsClient {
    readonly exchange: ExchangeName;
    connect(symbols: string[]): Promise<void>;
    close(): Promise<void>;
}

export interface ExchangePosition {
    exchange: ExchangeName;
    symbol: string;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
}

export interface PositionReader {
    readonly exchange: ExchangeName;
    fetchOpenPositions(symbols: string[]): Promise<ExchangePosition[]>;
}

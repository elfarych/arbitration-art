import type {
    ExchangePosition,
    ExchangeTicker,
    MarketOrderSubmission,
    OrderResult,
    SymbolMarketInfo,
} from '../types/index.js';

export interface ExchangeClientOptions {
    apiKey?: string;
    secret?: string;
    useTestnet?: boolean;
}

/**
 * Unified interface for exchange operations.
 * All REST exchange clients implement this contract so Trader can place orders,
 * set account parameters and read market constraints without exchange-specific
 * branching in the trading loop.
 */
export interface IExchangeClient {
    readonly name: string;

    /** Fetch exchange server time in milliseconds */
    fetchTime(): Promise<number>;

    /** Fetch normalized 24h ticker data keyed by internal symbol */
    fetchTickers(symbols?: string[]): Promise<Record<string, ExchangeTicker>>;

    /** Fetch normalized open positions for internal symbols */
    fetchPositions(symbols: string[]): Promise<ExchangePosition[]>;

    /** Fetch all normalized open USDT futures positions visible to this API key */
    fetchAllOpenPositions(): Promise<ExchangePosition[]>;

    /** Load all market data (call once at bootstrap) */
    loadMarkets(): Promise<void>;

    /** Set leverage for a specific symbol */
    setLeverage(symbol: string, leverage: number): Promise<void>;

    /** Set margin mode to isolated for a specific symbol */
    setIsolatedMargin(symbol: string): Promise<void>;

    /** Place a market order */
    createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params?: { reduceOnly?: boolean; clientOrderId?: string },
    ): Promise<OrderResult>;

    /** Submit a market order and return the private create-order ACK */
    submitMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params?: { reduceOnly?: boolean; clientOrderId?: string },
    ): Promise<MarketOrderSubmission>;

    /** Confirm market-order status, fills and commission after a submit ACK */
    confirmOrderResult(submission: MarketOrderSubmission): Promise<OrderResult>;

    /** Get market info (lot sizes, precision, etc.) for a symbol */
    getMarketInfo(symbol: string): SymbolMarketInfo | null;

    /** Get all available USDT perpetual symbols */
    getUsdtSymbols(): string[];

    /** Verify that private API access works for the configured credentials */
    pingPrivate(): Promise<void>;

    /** Verify account position mode is compatible with one-way reduce-only flow */
    validateAccountMode(): Promise<void>;
}

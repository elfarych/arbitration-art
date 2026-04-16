import type { OrderResult, SymbolMarketInfo } from '../types/index.js';

/**
 * Unified interface for exchange operations.
 * Both Binance and Bybit clients implement this contract.
 */
export interface IExchangeClient {
    readonly name: string;

    /** Expose underlying ccxt instance */
    readonly ccxtInstance: any;

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
        params?: any,
    ): Promise<OrderResult>;

    /** Get market info (lot sizes, precision, etc.) for a symbol */
    getMarketInfo(symbol: string): SymbolMarketInfo | null;

    /** Get all available USDT perpetual symbols */
    getUsdtSymbols(): string[];
}

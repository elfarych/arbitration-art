import type { OrderResult, SymbolMarketInfo } from '../types/index.js';

/**
 * Unified interface for exchange operations.
 * Every REST exchange adapter implements this contract so BotTrader can execute
 * the same open/close workflow without depending on exchange-specific APIs.
 *
 * WebSocket orderbook streaming is intentionally not part of this interface:
 * Engine creates separate ccxt.pro clients for that concern.
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

    /**
     * Place a market order. Returns as soon as the exchange acknowledges the
     * fill with orderId + avgPrice + filledQty. Commission is NOT fetched here
     * because that would block the latency-critical execution path; use
     * fetchOrderCommission afterwards (typically as a background task).
     */
    createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params?: any,
    ): Promise<OrderResult>;

    /**
     * Fetch the realized commission (in USDT equivalent) for a previously placed
     * order. Implementations should retry briefly because exchange fee endpoints
     * may lag behind the order itself by hundreds of milliseconds. Returns 0 if
     * the commission cannot be determined.
     */
    fetchOrderCommission(symbol: string, orderId: string): Promise<number>;

    /** Get market info (lot sizes, precision, etc.) for a symbol */
    getMarketInfo(symbol: string): SymbolMarketInfo | null;

    /** Get all available USDT perpetual symbols */
    getUsdtSymbols(): string[];
}

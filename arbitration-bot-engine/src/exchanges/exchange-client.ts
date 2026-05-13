import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import type { ExchangePosition, ExchangeTicker, MarketWsClient } from './market-ws.js';
import type { OrderBookStore } from '../market-data/orderbook-store.js';

/**
 * Unified interface implemented by every native REST exchange adapter.
 *
 * The engine intentionally has no `ccxt` runtime dependency. Each adapter
 * speaks the exchange's REST API directly and exposes the small surface that
 * BotTrader, MarketInfoService and exchange-tester actually use.
 *
 * Market data streaming is a separate concern delivered through the
 * `createMarketWs` factory, which returns a self-contained WebSocket client
 * that pushes parsed snapshots into the shared `OrderBookStore`.
 */
export interface IExchangeClient {
    /** Display name used in logs and `<name>_futures` Django payload fields. */
    readonly name: string;

    /** Lowercase tag matching OrderBookStore exchange keys (`binance`/`bybit`/...). */
    readonly exchangeKey: string;

    /** Cache market metadata once at startup; must be called before signing-sensitive ops. */
    loadMarkets(): Promise<void>;

    /** Set leverage for a specific unified symbol. Idempotent across calls. */
    setLeverage(symbol: string, leverage: number): Promise<void>;

    /** Switch the symbol to isolated margin mode. Idempotent across calls. */
    setIsolatedMargin(symbol: string): Promise<void>;

    /**
     * Optional warm-up for account/position-level settings that influence
     * order construction (e.g. Binance Hedge Mode `positionSide`, Bybit
     * `positionIdx`, Gate `auto_size`). Called once when a bot starts and
     * before any test trade, so the hot path never pays for a per-order
     * probe. The `symbol` is supplied because some exchanges (Bybit) expose
     * the flag per-symbol; adapters that only need an account-level flag may
     * ignore it. Implementations must be idempotent and never throw — any
     * failure must be swallowed and reported via logger; the adapter is then
     * free to fall back to the exchange's default mode on the first order.
     */
    prefetchAccountSettings?(symbol: string): Promise<void>;

    /**
     * Place a market order. Returns once the exchange confirms a fill with
     * orderId/avgPrice/filledQty. Commission backfill is intentionally split
     * into `fetchOrderCommission` so the hot path never blocks on fee polling.
     */
    createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params?: { reduceOnly?: boolean },
    ): Promise<OrderResult>;

    /**
     * Fetch realised commission for a previously placed order. Returns 0 if
     * the exchange does not surface the fee within the internal retry budget.
     */
    fetchOrderCommission(symbol: string, orderId: string): Promise<number>;

    /** Lot/precision/min-notional info derived from cached market metadata. */
    getMarketInfo(symbol: string): SymbolMarketInfo | null;

    /** All USDT-perpetual symbols available on this exchange (unified format). */
    getUsdtSymbols(): string[];

    /** Fetch open positions for the given symbols, returning a normalised list. */
    fetchPositions(symbols: string[]): Promise<ExchangePosition[]>;

    /** Fetch the latest ticker for a single symbol (last price + 24h quote volume). */
    fetchTicker(symbol: string): Promise<ExchangeTicker>;

    /**
     * Factory for the matching native market data WS client. The client
     * pushes snapshots into the supplied store keyed by `exchangeKey`.
     */
    createMarketWs(store: OrderBookStore): MarketWsClient;
}

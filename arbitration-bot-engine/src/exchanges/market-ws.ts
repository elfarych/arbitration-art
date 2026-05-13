/**
 * Common shape for native market data WebSocket clients.
 *
 * Every exchange-specific market WS client implements this interface so the
 * Engine and BotTrader can wire them generically. Clients are responsible for
 * connecting, subscribing, parsing snapshot/delta payloads into the store's
 * unified `OrderBookSnapshot` shape, and recovering on transient errors.
 */
export interface MarketWsClient {
    /** Lowercase exchange tag used as the store key (e.g. `'binance'`). */
    readonly exchange: string;

    /**
     * Open the WS connection and subscribe to the given unified symbols
     * (e.g. `BTC/USDT:USDT`). Resolves once the socket is open and the
     * subscribe payload has been sent; first snapshots arrive asynchronously.
     */
    connect(symbols: string[]): Promise<void>;

    /** Close the underlying socket and stop reconnect loops. */
    close(): Promise<void>;

    /** True while the socket is open and authenticated/subscribed. */
    isOpen(): boolean;
}

/**
 * Exchange position as returned by REST clients.
 *
 * Shape kept compatible with the values BotTrader previously consumed from
 * ccxt's `fetchPositions` response, so callers do not need to branch on
 * exchange. `size` is the absolute base-coin quantity; `side` collapses
 * long/short into the engine-internal vocabulary.
 */
export interface ExchangePosition {
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
}

/** Lightweight ticker shape used by MarketInfoService and exchange-tester. */
export interface ExchangeTicker {
    last: number;
    quoteVolume: number;
}

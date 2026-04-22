// ──────────── Orderbook ────────────

/**
 * Normalized top-of-book/VWAP prices for the two legs of one arbitrage pair.
 * "Primary" and "secondary" come from BotConfig, not from a hardcoded exchange.
 */
export interface OrderbookPrices {
    primaryBid: number;
    primaryAsk: number;
    secondaryBid: number;
    secondaryAsk: number;
}

// ──────────── Market Info ────────────

/**
 * Exchange-specific market constraints converted into a common shape.
 * These values are used before placing orders so the engine can round amounts
 * down to valid lot sizes and reject trades below exchange minimums.
 */
export interface SymbolMarketInfo {
    symbol: string;
    /** Minimum order quantity (in coins) */
    minQty: number;
    /** Quantity step (lot size precision) */
    stepSize: number;
    /** Minimum notional value (USDT) */
    minNotional: number;
    /** Price precision (decimal places) */
    pricePrecision: number;
    /** Quantity precision (decimal places) */
    quantityPrecision: number;
}

/**
 * Unified market info for a symbol across both exchanges.
 * Contains the strictest constraints to ensure orders pass on both.
 */
export interface UnifiedMarketInfo {
    symbol: string;
    /** Max of both exchanges' step sizes */
    stepSize: number;
    /** Max of both exchanges' min quantities */
    minQty: number;
    /** Max of both exchanges' min notional values */
    minNotional: number;
    /** Pre-calculated amount of coins for the configured USDT volume */
    tradeAmount: number;
    /** Whether this pair is tradeable on both exchanges */
    tradeable: boolean;
}

// ──────────── Order Execution ────────────

/**
 * Normalized result returned by every REST exchange client after placing an
 * order. BotTrader uses this shape to record actual fill prices and commissions
 * in Django regardless of the exchange-specific raw response format.
 */
export interface OrderResult {
    orderId: string;
    avgPrice: number;
    filledQty: number;
    commission: number;
    commissionAsset: string;
    status: string;
    raw: any;
}

// ──────────── Trade (Django API) ────────────

/**
 * Payload used when the engine opens a real trade in Django.
 *
 * Emulation trades reuse most of this shape at runtime, although Django's
 * EmulationTrade serializer does not require all real-trade-only fields.
 */
export interface TradeOpenPayload {
    coin: string;
    primary_exchange: string;
    secondary_exchange: string;
    order_type: 'buy' | 'sell';
    status: 'open';
    amount: number;
    leverage: number;
    primary_open_price: number;
    secondary_open_price: number;
    primary_open_order_id: string;
    secondary_open_order_id: string;
    open_spread: number;
    open_commission: number;
}

export interface TradeClosePayload {
    status: 'closed' | 'force_closed';
    // This should stay aligned with Django Trade.CloseReason choices. At the
    // moment BotTrader can produce some engine-only reasons and then map them
    // before sending real-trade payloads.
    close_reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation';
    primary_close_price: number;
    secondary_close_price: number;
    primary_close_order_id: string;
    secondary_close_order_id: string;
    close_spread: number;
    close_commission: number;
    profit_usdt: number;
    profit_percentage: number;
    closed_at: string;
}

export interface TradeRecord {
    // Django returns DecimalField values as strings. BotTrader parses those
    // strings at close time to avoid floating-point assumptions at the API edge.
    id: number;
    coin: string;
    primary_exchange: string;
    secondary_exchange: string;
    order_type: 'buy' | 'sell';
    status: string;
    amount: number;
    leverage: number;
    primary_open_price: string;
    secondary_open_price: string;
    primary_open_order_id: string;
    secondary_open_order_id: string;
    open_spread: string;
    open_commission: string;
    opened_at: string;
}

// ──────────── Orderbook ────────────

export interface OrderbookPrices {
    primaryBid: number;
    primaryAsk: number;
    secondaryBid: number;
    secondaryAsk: number;
}

// ──────────── Market Info ────────────

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

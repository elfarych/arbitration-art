// ──────────── Control Plane ────────────

export interface RuntimeKeysPayload {
    binance_api_key?: string;
    binance_secret?: string;
    bybit_api_key?: string;
    bybit_secret?: string;
    gate_api_key?: string;
    gate_secret?: string;
    mexc_api_key?: string;
    mexc_secret?: string;
}

export interface RuntimeConfigPayload {
    id: number;
    name: string;
    primary_exchange: string;
    secondary_exchange: string;
    use_testnet: boolean;
    trade_amount_usdt: number | string;
    leverage: number;
    max_concurrent_trades: number;
    top_liquid_pairs_count: number;
    max_trade_duration_minutes: number;
    max_leg_drawdown_percent: number | string;
    open_threshold: number | string;
    close_threshold: number | string;
    orderbook_limit: number;
    chunk_size: number;
    is_active: boolean;
    min_open_net_edge_percent?: number | string;
    entry_fee_buffer_percent?: number | string;
    entry_slippage_buffer_percent?: number | string;
    funding_buffer_percent?: number | string;
    latency_buffer_percent?: number | string;
    shadow_mode?: boolean;
}

export interface RuntimeCommandPayload {
    runtime_config_id: number;
    owner_id: number;
    config: RuntimeConfigPayload;
    keys: RuntimeKeysPayload;
}

export type RuntimeConfigErrorType =
    | 'start'
    | 'sync'
    | 'stop'
    | 'runtime'
    | 'exchange_health'
    | 'diagnostics'
    | 'validation'
    | 'control_plane';

export interface RuntimeConfigErrorPayload {
    runtime_config: number;
    error_type: RuntimeConfigErrorType;
    error_text: string;
}

export interface ExchangeHealthCheckResult {
    exchange: string;
    available: boolean;
    error: string | null;
}

export interface RuntimeTradePnlSnapshot {
    trade_id: number;
    coin: string;
    order_type: 'buy' | 'sell';
    amount: number;
    opened_at: string;
    current_pnl_percent: number | null;
    estimated_pnl_usdt: number | null;
    estimated_pnl_percentage: number | null;
    pricing_mode: 'strict' | 'emergency' | 'unavailable';
}

export interface RuntimeTradesDiagnostics {
    requested_runtime_config_id: number | null;
    active_runtime_config_id: number | null;
    is_requested_runtime_active: boolean;
    trade_count: number;
    active_coins: string[];
    trades: RuntimeTradePnlSnapshot[];
}

export interface SystemLoadSnapshot {
    cpu_percent: number;
    memory_total_bytes: number;
    memory_used_bytes: number;
    memory_free_bytes: number;
    memory_used_percent: number;
}

export interface ServerInfoSnapshot {
    requested_runtime_config_id: number | null;
    hostname: string;
    server_ip: string | null;
    ip_addresses: string[];
}

// ──────────── Exchange Data ────────────

export interface ExchangeTicker {
    symbol: string;
    last: number;
    quoteVolume: number;
    fundingRate: number | null;
    nextFundingTime: number | null;
    raw: unknown;
}

export interface ExchangePosition {
    symbol: string;
    side: 'long' | 'short';
    amount: number;
    contracts: number;
    entryPrice: number;
    raw: unknown;
}

// ──────────── Orderbook ────────────

export interface OrderBookSnapshot {
    symbol: string;
    bids: [number, number][];
    asks: [number, number][];
    exchangeTimestamp: number | null;
    localTimestamp: number;
    sequence: string | number | null;
    isSynced: boolean;
}

export interface OrderBookProvider {
    readonly exchange: string;
    connect(): Promise<void>;
    subscribe(symbols: string[]): Promise<void>;
    unsubscribe(symbols: string[]): Promise<void>;
    getOrderBook(symbol: string): OrderBookSnapshot | null;
    onUpdate(listener: (symbol: string) => void): () => void;
    close(): Promise<void>;
}

/**
 * Normalized VWAP/top-of-book prices for one symbol across the configured
 * primary and secondary exchanges.
 */
export interface OrderbookPrices {
    primaryBid: number;
    primaryAsk: number;
    secondaryBid: number;
    secondaryAsk: number;
}

// ──────────── Market Info ────────────

/**
 * Exchange-specific market constraints converted into a common internal shape.
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
    /** Decimal LCM of both exchanges' quantity steps */
    stepSize: number;
    /** Max of both exchanges' min quantities */
    minQty: number;
    /** Max of both exchanges' min notional values */
    minNotional: number;
    /** Pre-calculated amount of coins for the configured USDT volume */
    tradeAmount: number;
    /** Latest funding rate from the primary exchange, as decimal fraction */
    primaryFundingRate: number | null;
    /** Latest funding rate from the secondary exchange, as decimal fraction */
    secondaryFundingRate: number | null;
    /** Next funding timestamp from the primary exchange, milliseconds */
    primaryNextFundingTime: number | null;
    /** Next funding timestamp from the secondary exchange, milliseconds */
    secondaryNextFundingTime: number | null;
    /** Whether this pair is tradeable on both exchanges */
    tradeable: boolean;
}

// ──────────── Order Execution ────────────

/**
 * Unified result returned by all exchange clients after market order execution.
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

/**
 * Exchange ACK returned after the private create-order request is accepted.
 * Fill polling and accounting are performed later through confirmOrderResult().
 */
export interface MarketOrderSubmission {
    symbol: string;
    side: 'buy' | 'sell';
    amount: number;
    reduceOnly: boolean;
    orderId?: string;
    clientOrderId: string;
    submittedAtMs: number;
    acknowledgedAtMs: number;
    raw: any;
}

// ──────────── Trade (Django API) ────────────

/**
 * Payload used to create a real Trade record in Django after both legs open.
 */
export interface TradeOpenPayload {
    runtime_config: number;
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
    // Keep this union aligned with Django Trade.CloseReason choices. The trader
    // maps liquidation to error before sending it to Django.
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
    // Django serializes DecimalField values as strings, so close logic parses
    // numeric fields explicitly before PnL calculations.
    id: number;
    runtime_config: number | null;
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

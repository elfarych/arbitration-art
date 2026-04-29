import dotenv from 'dotenv';

dotenv.config();

export type ExchangeName = 'binance' | 'bybit';

export interface RuntimeKeysPayload {
    binance_api_key?: string;
    binance_secret?: string;
    bybit_api_key?: string;
    bybit_secret?: string;
}

export interface RuntimeConfigPayload {
    id: number;
    name: string;
    primary_exchange: ExchangeName | string;
    secondary_exchange: ExchangeName | string;
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
}

export interface RuntimeCommandPayload {
    runtime_config_id: number;
    owner_id: number;
    config: RuntimeConfigPayload;
    keys: RuntimeKeysPayload;
}

export interface NormalizedRuntimeConfig {
    runtimeConfigId: number;
    ownerId: number;
    name: string;
    primaryExchange: ExchangeName;
    secondaryExchange: ExchangeName;
    useTestnet: boolean;
    tradeAmountUsdt: number;
    leverage: number;
    maxConcurrentTrades: number;
    topLiquidPairsCount: number;
    maxTradeDurationMs: number;
    maxLegDrawdownPercent: number;
    openThreshold: number;
    closeThreshold: number;
    orderbookLimit: number;
    orderbookMaxAgeMs: number;
    orderbookMaxSkewMs: number;
    maxTradeNotionalUsdt: number;
}

export const appConfig = {
    port: readNumber('PORT', 3003),
    djangoApiUrl: readString('DJANGO_API_URL', 'http://127.0.0.1:8000/api').replace(/\/$/, ''),
    serviceToken: readRequiredString('SERVICE_SHARED_TOKEN'),
    traderInstanceId: readOptionalString('TRADER_INSTANCE_ID'),
    defaultUseTestnet: readBool('USE_TESTNET', true),
    defaultTradeAmountUsdt: readNumber('TRADE_AMOUNT_USDT', 50),
    defaultMaxConcurrentTrades: readNumber('MAX_CONCURRENT_TRADES', 3),
    maxTradeNotionalUsdt: readNumber('MAX_TRADE_NOTIONAL_USDT', 100),
    defaultOpenThreshold: readNumber('OPEN_THRESHOLD', 1),
    defaultCloseThreshold: readNumber('CLOSE_THRESHOLD', 0.2),
    defaultOrderbookLimit: readNumber('ORDERBOOK_LIMIT', 20),
    orderbookMaxAgeMs: readNumber('ORDERBOOK_MAX_AGE_MS', 2000),
    orderbookMaxSkewMs: readNumber('ORDERBOOK_MAX_SKEW_MS', 1000),
    enableAsyncPersistence: readBool('ENABLE_ASYNC_PERSISTENCE', true),
    enableBackgroundReconciliation: readBool('ENABLE_BACKGROUND_RECONCILIATION', true),
    asyncEventLogPath: readString('ASYNC_EVENT_LOG_PATH', 'logs/ws-futures-events.jsonl'),
    recoveryMarkerPath: readString('RECOVERY_MARKER_PATH', 'logs/ws-futures-recovery.jsonl'),
    persistenceRetryDelayMs: readNumber('PERSISTENCE_RETRY_DELAY_MS', 1000),
    errorReportThrottleMs: readNumber('ERROR_REPORT_THROTTLE_MS', 30000),
    leverageSetupDelayMs: readNumber('LEVERAGE_SETUP_DELAY_MS', 100),
    leverageSetupRetryDelayMs: readNumber('LEVERAGE_SETUP_RETRY_DELAY_MS', 2000),
    leverageSetupMaxRetries: readNumber('LEVERAGE_SETUP_MAX_RETRIES', 3),
    leverageSetupStrict: readBool('LEVERAGE_SETUP_STRICT', false),
    bybitRecvWindowMs: readNumber('BYBIT_RECV_WINDOW_MS', 15000),
    testTradeAmountUsdt: readNumber('TEST_TRADE_AMOUNT_USDT', 15),
    testTradeMaxNotionalUsdt: readNumber('TEST_TRADE_MAX_NOTIONAL_USDT', 25),
    testTradeCloseDelayMs: readNumber('TEST_TRADE_CLOSE_DELAY_MS', 250),
    binanceApiKey: readOptionalString('BINANCE_API_KEY'),
    binanceApiSecret: readOptionalString('BINANCE_API_SECRET'),
    bybitApiKey: readOptionalString('BYBIT_API_KEY'),
    bybitApiSecret: readOptionalString('BYBIT_API_SECRET'),
};

export interface NormalizeRuntimePayloadOptions {
    enforceTradeAmountCap?: boolean;
}

export function normalizeRuntimePayload(
    payload: RuntimeCommandPayload,
    options: NormalizeRuntimePayloadOptions = {},
): NormalizedRuntimeConfig {
    const primaryExchange = normalizeExchange(payload.config.primary_exchange);
    const secondaryExchange = normalizeExchange(payload.config.secondary_exchange);

    if (primaryExchange === secondaryExchange) {
        throw new Error('primary_exchange and secondary_exchange must be different.');
    }

    const exchanges = new Set<ExchangeName>([primaryExchange, secondaryExchange]);
    if (!exchanges.has('binance') || !exchanges.has('bybit')) {
        throw new Error('Only Binance USD-M and Bybit linear route is supported.');
    }

    const tradeAmountUsdt = toPositiveNumber(payload.config.trade_amount_usdt, 'trade_amount_usdt');
    const maxTradeNotionalUsdt = appConfig.maxTradeNotionalUsdt;
    if (options.enforceTradeAmountCap !== false && tradeAmountUsdt > maxTradeNotionalUsdt) {
        throw new Error(`trade_amount_usdt exceeds MAX_TRADE_NOTIONAL_USDT=${maxTradeNotionalUsdt}.`);
    }

    return {
        runtimeConfigId: payload.runtime_config_id,
        ownerId: payload.owner_id,
        name: payload.config.name,
        primaryExchange,
        secondaryExchange,
        useTestnet: Boolean(payload.config.use_testnet),
        tradeAmountUsdt,
        leverage: toPositiveNumber(payload.config.leverage, 'leverage'),
        maxConcurrentTrades: toPositiveNumber(payload.config.max_concurrent_trades, 'max_concurrent_trades'),
        topLiquidPairsCount: toPositiveNumber(payload.config.top_liquid_pairs_count, 'top_liquid_pairs_count'),
        maxTradeDurationMs: toPositiveNumber(payload.config.max_trade_duration_minutes, 'max_trade_duration_minutes') * 60_000,
        maxLegDrawdownPercent: toPositiveNumber(payload.config.max_leg_drawdown_percent, 'max_leg_drawdown_percent'),
        openThreshold: toFiniteNumber(payload.config.open_threshold, 'open_threshold'),
        closeThreshold: toFiniteNumber(payload.config.close_threshold, 'close_threshold'),
        orderbookLimit: toPositiveNumber(payload.config.orderbook_limit, 'orderbook_limit'),
        orderbookMaxAgeMs: appConfig.orderbookMaxAgeMs,
        orderbookMaxSkewMs: appConfig.orderbookMaxSkewMs,
        maxTradeNotionalUsdt,
    };
}

export function mergeEnvKeys(payloadKeys: RuntimeKeysPayload): Required<RuntimeKeysPayload> {
    return {
        binance_api_key: payloadKeys.binance_api_key || appConfig.binanceApiKey || '',
        binance_secret: payloadKeys.binance_secret || appConfig.binanceApiSecret || '',
        bybit_api_key: payloadKeys.bybit_api_key || appConfig.bybitApiKey || '',
        bybit_secret: payloadKeys.bybit_secret || appConfig.bybitApiSecret || '',
    };
}

function normalizeExchange(value: string): ExchangeName {
    if (value === 'binance' || value === 'bybit') {
        return value;
    }
    throw new Error(`Unsupported exchange: ${value}`);
}

function toFiniteNumber(value: number | string, name: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a finite number.`);
    }
    return parsed;
}

function toPositiveNumber(value: number | string, name: string): number {
    const parsed = toFiniteNumber(value, name);
    if (parsed <= 0) {
        throw new Error(`${name} must be positive.`);
    }
    return parsed;
}

function readString(name: string, fallback: string): string {
    return process.env[name]?.trim() || fallback;
}

function readOptionalString(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function readRequiredString(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required.`);
    }
    return value;
}

function readNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const value = Number(raw.trim().replace(/_/g, ''));
    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number.`);
    }
    return value;
}

function readBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

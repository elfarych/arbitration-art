import * as dotenv from 'dotenv';

dotenv.config();

export interface TraderRuntimeKeys {
    binance_api_key?: string;
    binance_secret?: string;
    bybit_api_key?: string;
    bybit_secret?: string;
    gate_api_key?: string;
    gate_secret?: string;
    mexc_api_key?: string;
    mexc_secret?: string;
}

export interface TraderRuntimeConfigPayload {
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
}

export interface TraderRuntimePayload {
    runtime_config_id: number;
    owner_id: number;
    config: TraderRuntimeConfigPayload;
    keys: TraderRuntimeKeys;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`[Config] Missing required environment variable: ${name}`);
    }
    return value;
}

let activeRuntime: TraderRuntimePayload | null = null;

function requireActiveRuntime(): TraderRuntimePayload {
    if (!activeRuntime) {
        throw new Error('[Config] No active runtime configuration is loaded.');
    }

    return activeRuntime;
}

export function setActiveRuntime(payload: TraderRuntimePayload): void {
    activeRuntime = payload;
}

export function clearActiveRuntime(): void {
    activeRuntime = null;
}

export function getActiveRuntime(): TraderRuntimePayload | null {
    return activeRuntime;
}

export const config = {
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    port: Number(process.env.PORT || '3002'),
    serviceToken: requireEnv('SERVICE_SHARED_TOKEN'),

    get runtimeConfigId(): number {
        return requireActiveRuntime().runtime_config_id;
    },

    get ownerId(): number {
        return requireActiveRuntime().owner_id;
    },

    get runtimeName(): string {
        return requireActiveRuntime().config.name;
    },

    get binance() {
        const { keys } = requireActiveRuntime();
        return {
            apiKey: keys.binance_api_key || '',
            secret: keys.binance_secret || '',
        };
    },

    get bybit() {
        const { keys } = requireActiveRuntime();
        return {
            apiKey: keys.bybit_api_key || '',
            secret: keys.bybit_secret || '',
        };
    },

    get gate() {
        const { keys } = requireActiveRuntime();
        return {
            apiKey: keys.gate_api_key || '',
            secret: keys.gate_secret || '',
        };
    },

    get mexc() {
        const { keys } = requireActiveRuntime();
        return {
            apiKey: keys.mexc_api_key || '',
            secret: keys.mexc_secret || '',
        };
    },

    get primaryExchange(): string {
        return requireActiveRuntime().config.primary_exchange.toLowerCase();
    },

    get secondaryExchange(): string {
        return requireActiveRuntime().config.secondary_exchange.toLowerCase();
    },

    get useTestnet(): boolean {
        return Boolean(requireActiveRuntime().config.use_testnet);
    },

    get tradeAmountUsdt(): number {
        return Number(requireActiveRuntime().config.trade_amount_usdt);
    },

    get leverage(): number {
        return Number(requireActiveRuntime().config.leverage);
    },

    get maxConcurrentTrades(): number {
        return Number(requireActiveRuntime().config.max_concurrent_trades);
    },

    get maxTradeDurationMs(): number {
        return Number(requireActiveRuntime().config.max_trade_duration_minutes) * 60 * 1000;
    },

    get maxLegDrawdownPercent(): number {
        return Number(requireActiveRuntime().config.max_leg_drawdown_percent);
    },

    get openThreshold(): number {
        return Number(requireActiveRuntime().config.open_threshold);
    },

    get closeThreshold(): number {
        return Number(requireActiveRuntime().config.close_threshold);
    },

    get orderbookLimit(): number {
        return Number(requireActiveRuntime().config.orderbook_limit);
    },

    get chunkSize(): number {
        return Number(requireActiveRuntime().config.chunk_size);
    },

    get topLiquidPairsCount(): number {
        return Number(requireActiveRuntime().config.top_liquid_pairs_count);
    },
} as const;

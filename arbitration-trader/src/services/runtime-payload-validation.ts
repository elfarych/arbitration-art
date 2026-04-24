import type { RuntimeCommandPayload, RuntimeConfigPayload, RuntimeKeysPayload } from '../types/index.js';

export class PayloadValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PayloadValidationError';
    }
}

const ALLOWED_EXCHANGES = new Set(['binance', 'bybit', 'mexc', 'gate']);
const REQUIRED_KEY_FIELDS: Record<string, Array<keyof RuntimeKeysPayload>> = {
    binance: ['binance_api_key', 'binance_secret'],
    bybit: ['bybit_api_key', 'bybit_secret'],
    mexc: ['mexc_api_key', 'mexc_secret'],
    gate: ['gate_api_key', 'gate_secret'],
};

export function parseRuntimeCommandPayload(value: unknown): RuntimeCommandPayload {
    const root = requireRecord(value, 'payload');
    const config = requireRecord(root.config, 'payload.config');
    const keys = requireRecord(root.keys, 'payload.keys');

    const runtimeConfigId = requirePositiveInteger(root.runtime_config_id, 'runtime_config_id');
    const ownerId = requirePositiveInteger(root.owner_id, 'owner_id');
    const parsedConfig = parseConfig(config);
    const parsedKeys = parseKeys(keys);

    if (parsedConfig.id !== runtimeConfigId) {
        throw new PayloadValidationError('runtime_config_id must match config.id.');
    }

    validateExchangeKeys(parsedConfig, parsedKeys);

    return {
        runtime_config_id: runtimeConfigId,
        owner_id: ownerId,
        config: parsedConfig,
        keys: parsedKeys,
    };
}

export function parseStopPayload(value: unknown): { runtime_config_id?: number } {
    if (value === undefined || value === null || value === '') {
        return {};
    }

    const root = requireRecord(value, 'payload');
    if (root.runtime_config_id === undefined || root.runtime_config_id === null) {
        return {};
    }

    return {
        runtime_config_id: requirePositiveInteger(root.runtime_config_id, 'runtime_config_id'),
    };
}

export function parseRuntimeConfigId(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    return requirePositiveInteger(value, 'runtime_config_id');
}

function parseConfig(config: Record<string, unknown>): RuntimeConfigPayload {
    const primaryExchange = requireExchangeName(config.primary_exchange, 'config.primary_exchange');
    const secondaryExchange = requireExchangeName(config.secondary_exchange, 'config.secondary_exchange');

    if (primaryExchange === secondaryExchange) {
        throw new PayloadValidationError('config.primary_exchange and config.secondary_exchange must be different.');
    }

    return {
        id: requirePositiveInteger(config.id, 'config.id'),
        name: requireNonEmptyString(config.name, 'config.name'),
        primary_exchange: primaryExchange,
        secondary_exchange: secondaryExchange,
        use_testnet: requireBoolean(config.use_testnet, 'config.use_testnet'),
        trade_amount_usdt: requirePositiveFinite(config.trade_amount_usdt, 'config.trade_amount_usdt'),
        leverage: requireIntegerInRange(config.leverage, 'config.leverage', 1, 125),
        max_concurrent_trades: requireIntegerInRange(config.max_concurrent_trades, 'config.max_concurrent_trades', 1, 100),
        top_liquid_pairs_count: requireIntegerInRange(config.top_liquid_pairs_count, 'config.top_liquid_pairs_count', 1, 1000),
        max_trade_duration_minutes: requireIntegerInRange(config.max_trade_duration_minutes, 'config.max_trade_duration_minutes', 1, 1440),
        max_leg_drawdown_percent: requireFiniteInRange(config.max_leg_drawdown_percent, 'config.max_leg_drawdown_percent', 1, 100),
        open_threshold: requireFiniteInRange(config.open_threshold, 'config.open_threshold', 0, 100),
        close_threshold: requireFiniteInRange(config.close_threshold, 'config.close_threshold', 0, 100),
        orderbook_limit: requireIntegerInRange(config.orderbook_limit, 'config.orderbook_limit', 1, 1000),
        chunk_size: requireIntegerInRange(config.chunk_size, 'config.chunk_size', 1, 500),
        is_active: requireBoolean(config.is_active, 'config.is_active'),
        min_open_net_edge_percent: optionalFiniteInRange(config.min_open_net_edge_percent, 'config.min_open_net_edge_percent', 0, 100),
        entry_fee_buffer_percent: optionalFiniteInRange(config.entry_fee_buffer_percent, 'config.entry_fee_buffer_percent', 0, 100),
        entry_slippage_buffer_percent: optionalFiniteInRange(config.entry_slippage_buffer_percent, 'config.entry_slippage_buffer_percent', 0, 100),
        funding_buffer_percent: optionalFiniteInRange(config.funding_buffer_percent, 'config.funding_buffer_percent', 0, 100),
        latency_buffer_percent: optionalFiniteInRange(config.latency_buffer_percent, 'config.latency_buffer_percent', 0, 100),
        shadow_mode: optionalBoolean(config.shadow_mode, 'config.shadow_mode'),
    };
}

function parseKeys(keys: Record<string, unknown>): RuntimeKeysPayload {
    return {
        binance_api_key: optionalString(keys.binance_api_key, 'keys.binance_api_key'),
        binance_secret: optionalString(keys.binance_secret, 'keys.binance_secret'),
        bybit_api_key: optionalString(keys.bybit_api_key, 'keys.bybit_api_key'),
        bybit_secret: optionalString(keys.bybit_secret, 'keys.bybit_secret'),
        gate_api_key: optionalString(keys.gate_api_key, 'keys.gate_api_key'),
        gate_secret: optionalString(keys.gate_secret, 'keys.gate_secret'),
        mexc_api_key: optionalString(keys.mexc_api_key, 'keys.mexc_api_key'),
        mexc_secret: optionalString(keys.mexc_secret, 'keys.mexc_secret'),
    };
}

function validateExchangeKeys(config: RuntimeConfigPayload, keys: RuntimeKeysPayload): void {
    for (const exchange of [config.primary_exchange, config.secondary_exchange]) {
        for (const field of REQUIRED_KEY_FIELDS[exchange]) {
            if (!keys[field]?.trim()) {
                throw new PayloadValidationError(`keys.${field} is required for selected exchange ${exchange}.`);
            }
        }
    }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PayloadValidationError(`${field} must be an object.`);
    }

    return value as Record<string, unknown>;
}

function requireExchangeName(value: unknown, field: string): string {
    const exchange = requireNonEmptyString(value, field).toLowerCase();
    if (!ALLOWED_EXCHANGES.has(exchange)) {
        throw new PayloadValidationError(`${field} must be one of: ${[...ALLOWED_EXCHANGES].join(', ')}.`);
    }

    return exchange;
}

function requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new PayloadValidationError(`${field} must be a non-empty string.`);
    }

    return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new PayloadValidationError(`${field} must be a string.`);
    }

    return value;
}

function requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new PayloadValidationError(`${field} must be a boolean.`);
    }

    return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    return requireBoolean(value, field);
}

function requirePositiveInteger(value: unknown, field: string): number {
    return requireIntegerInRange(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
    const parsed = parseNumber(value, field);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new PayloadValidationError(`${field} must be an integer between ${min} and ${max}.`);
    }

    return parsed;
}

function requirePositiveFinite(value: unknown, field: string): number {
    const parsed = parseNumber(value, field);
    if (parsed <= 0) {
        throw new PayloadValidationError(`${field} must be greater than 0.`);
    }

    return parsed;
}

function requireFiniteInRange(value: unknown, field: string, min: number, max: number): number {
    const parsed = parseNumber(value, field);
    if (parsed < min || parsed > max) {
        throw new PayloadValidationError(`${field} must be between ${min} and ${max}.`);
    }

    return parsed;
}

function optionalFiniteInRange(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    return requireFiniteInRange(value, field, min, max);
}

function parseNumber(value: unknown, field: string): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) {
        throw new PayloadValidationError(`${field} must be a finite number.`);
    }

    return parsed;
}

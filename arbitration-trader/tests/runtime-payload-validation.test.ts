import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRuntimeCommandPayload,
    parseRuntimeConfigId,
    parseStopPayload,
    PayloadValidationError,
} from '../src/services/runtime-payload-validation.js';

const validPayload = {
    runtime_config_id: 1,
    owner_id: 2,
    config: {
        id: 1,
        name: 'test',
        primary_exchange: 'binance',
        secondary_exchange: 'bybit',
        use_testnet: true,
        trade_amount_usdt: '50',
        leverage: 10,
        max_concurrent_trades: 3,
        top_liquid_pairs_count: 100,
        max_trade_duration_minutes: 60,
        max_leg_drawdown_percent: '80',
        open_threshold: '2',
        close_threshold: '1.5',
        orderbook_limit: 50,
        chunk_size: 10,
        is_active: true,
    },
    keys: {
        binance_api_key: 'binance-key',
        binance_secret: 'binance-secret',
        bybit_api_key: 'bybit-key',
        bybit_secret: 'bybit-secret',
    },
};

test('parseRuntimeCommandPayload validates and normalizes payload', () => {
    const parsed = parseRuntimeCommandPayload(validPayload);

    assert.equal(parsed.config.primary_exchange, 'binance');
    assert.equal(parsed.config.trade_amount_usdt, 50);
});

test('parseRuntimeCommandPayload rejects invalid chunk size', () => {
    assert.throws(
        () => parseRuntimeCommandPayload({
            ...validPayload,
            config: { ...validPayload.config, chunk_size: 0 },
        }),
        PayloadValidationError,
    );
});

test('parseRuntimeCommandPayload rejects missing selected exchange keys', () => {
    assert.throws(
        () => parseRuntimeCommandPayload({
            ...validPayload,
            keys: { ...validPayload.keys, bybit_secret: '' },
        }),
        PayloadValidationError,
    );
});

test('parseRuntimeConfigId and parseStopPayload accept positive ids only', () => {
    assert.equal(parseRuntimeConfigId('10'), 10);
    assert.deepEqual(parseStopPayload({ runtime_config_id: '11' }), { runtime_config_id: 11 });
    assert.throws(() => parseRuntimeConfigId('-1'), PayloadValidationError);
});

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_MAX_AGE_MS ||= '2000';
process.env.ORDERBOOK_MAX_SKEW_MS ||= '1000';

test('control plane exposes Django compatibility diagnostics routes', async () => {
    const { createControlPlane } = await import('../src/control-plane/server.js');
    const runtimeManager = fakeRuntimeManager();
    const app = createControlPlane({
        runtimeManager: runtimeManager as never,
        runtimeConfigClient: {} as never,
        errorReporter: fakeErrorReporter() as never,
    });

    const activeCoins = await app.inject({
        method: 'GET',
        url: '/engine/trader/runtime/active-coins?runtime_config_id=2',
        headers: serviceHeaders(),
    });
    assert.equal(activeCoins.statusCode, 200);
    assert.deepEqual(JSON.parse(activeCoins.body), {
        requested_runtime_config_id: 2,
        active_runtime_config_id: null,
        is_requested_runtime_active: false,
        trade_count: 0,
        active_coins: [],
    });

    const systemLoad = await app.inject({
        method: 'GET',
        url: '/engine/trader/runtime/system-load?runtime_config_id=2',
        headers: serviceHeaders(),
    });
    assert.equal(systemLoad.statusCode, 200);
    const systemLoadBody = JSON.parse(systemLoad.body);
    assert.equal(systemLoadBody.requested_runtime_config_id, 2);
    assert.equal(systemLoadBody.runtime_state, 'idle');
    assert.equal(typeof systemLoadBody.cpu_percent, 'number');

    const exchangeHealth = await app.inject({
        method: 'POST',
        url: '/engine/trader/runtime/exchange-health',
        headers: serviceHeaders(),
        payload: runtimePayload(),
    });
    assert.equal(exchangeHealth.statusCode, 200);
    assert.deepEqual(JSON.parse(exchangeHealth.body), {
        requested_runtime_config_id: 2,
        active_runtime_config_id: null,
        exchanges: [
            { exchange: 'binance', available: true, error: null },
            { exchange: 'bybit', available: true, error: null },
        ],
    });

    await app.close();
});

test('control plane exposes Django compatibility lifecycle routes', async () => {
    const { createControlPlane } = await import('../src/control-plane/server.js');
    const runtimeManager = fakeRuntimeManager();
    const app = createControlPlane({
        runtimeManager: runtimeManager as never,
        runtimeConfigClient: {} as never,
        errorReporter: fakeErrorReporter() as never,
    });

    const start = await app.inject({
        method: 'POST',
        url: '/engine/trader/start',
        headers: serviceHeaders(),
        payload: runtimePayload(),
    });
    assert.equal(start.statusCode, 200);
    assert.equal(runtimeManager.started, 1);

    const stop = await app.inject({
        method: 'POST',
        url: '/engine/trader/stop',
        headers: serviceHeaders(),
        payload: { runtime_config_id: 2 },
    });
    assert.equal(stop.statusCode, 200);
    assert.equal(runtimeManager.stopped, 1);

    await app.close();
});

function serviceHeaders(): Record<string, string> {
    return { 'x-service-token': 'test-token' };
}

function runtimePayload() {
    return {
        runtime_config_id: 2,
        owner_id: 1,
        config: {
            id: 2,
            name: 'runtime',
            primary_exchange: 'binance',
            secondary_exchange: 'bybit',
            use_testnet: true,
            trade_amount_usdt: '10',
            leverage: 3,
            max_concurrent_trades: 1,
            top_liquid_pairs_count: 10,
            max_trade_duration_minutes: 60,
            max_leg_drawdown_percent: '80',
            open_threshold: '1',
            close_threshold: '0.2',
            orderbook_limit: 20,
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
}

function fakeRuntimeManager() {
    return {
        started: 0,
        stopped: 0,
        status: () => 'idle',
        activeRuntimeConfigId: () => null,
        state: () => ({ status: 'idle' }),
        latency: () => [],
        pause: () => undefined,
        resume: () => undefined,
        start() {
            this.started += 1;
            return Promise.resolve();
        },
        stop() {
            this.stopped += 1;
            return Promise.resolve();
        },
        getActiveTradesDiagnostics(runtimeConfigId?: number) {
            return {
                requested_runtime_config_id: runtimeConfigId ?? null,
                active_runtime_config_id: null,
                is_requested_runtime_active: false,
                trade_count: 0,
                active_coins: [],
                trades: [],
            };
        },
        getRuntimeDiagnosticsState: () => ({
            activeRuntimeConfigId: null,
            runtimeState: 'idle',
            riskLocked: false,
        }),
        checkExchangeHealth: () => Promise.resolve({
            requested_runtime_config_id: 2,
            active_runtime_config_id: null,
            exchanges: [
                { exchange: 'binance', available: true, error: null },
                { exchange: 'bybit', available: true, error: null },
            ],
        }),
        runTestTrade: () => Promise.resolve({ success: true }),
    };
}

function fakeErrorReporter() {
    return {
        report: () => Promise.resolve(),
    };
}

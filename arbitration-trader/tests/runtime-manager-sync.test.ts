import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

const payload = {
    runtime_config_id: 1,
    owner_id: 1,
    config: {
        id: 1,
        name: 'sync-test',
        primary_exchange: 'bybit',
        secondary_exchange: 'gate',
        use_testnet: true,
        trade_amount_usdt: 10,
        leverage: 3,
        max_concurrent_trades: 3,
        top_liquid_pairs_count: 10,
        max_trade_duration_minutes: 15,
        max_leg_drawdown_percent: 80,
        open_threshold: 4,
        close_threshold: 2,
        orderbook_limit: 50,
        chunk_size: 10,
        is_active: true,
    },
    keys: {
        bybit_api_key: 'bybit-key',
        gate_api_key: 'gate-key',
    },
};

function clonePayload(value = payload) {
    return JSON.parse(JSON.stringify(value));
}

function attachActiveRuntime(manager: any, activePayload = payload, riskLocked = false) {
    manager.activeRuntime = {
        payload: activePayload,
        traders: [],
        riskLock: { isLocked: riskLocked },
        state: 'running',
        primaryClient: {},
        secondaryClient: {},
        primaryBooks: {},
        secondaryBooks: {},
        runPromise: new Promise(() => {}),
    };
}

test('RuntimeManager treats duplicate sync payload as no-op while runtime is running', async () => {
    const { RuntimeManager } = await import('../src/classes/RuntimeManager.js');
    const manager = new RuntimeManager() as any;
    attachActiveRuntime(manager);

    let stopped = false;
    let started = false;
    manager.stopActiveRuntime = async () => {
        stopped = true;
    };
    manager.startRuntime = async () => {
        started = true;
    };

    await manager.sync(clonePayload());

    assert.equal(stopped, false);
    assert.equal(started, false);
});

test('RuntimeManager keeps duplicate sync as no-op while runtime is risk-locked', async () => {
    const { RuntimeManager } = await import('../src/classes/RuntimeManager.js');
    const manager = new RuntimeManager() as any;
    attachActiveRuntime(manager, payload, true);

    let stopped = false;
    let started = false;
    manager.stopActiveRuntime = async () => {
        stopped = true;
    };
    manager.startRuntime = async () => {
        started = true;
    };

    await manager.sync(clonePayload());

    assert.equal(stopped, false);
    assert.equal(started, false);
});

test('RuntimeManager restarts on sync when payload changes', async () => {
    const { RuntimeManager } = await import('../src/classes/RuntimeManager.js');
    const manager = new RuntimeManager() as any;
    attachActiveRuntime(manager);

    let stopped = false;
    let started = false;
    manager.stopActiveRuntime = async () => {
        stopped = true;
        manager.activeRuntime = null;
    };
    manager.startRuntime = async () => {
        started = true;
    };

    const changedPayload = clonePayload({
        ...payload,
        config: {
            ...payload.config,
            leverage: 4,
        },
    });
    await manager.sync(changedPayload);

    assert.equal(stopped, true);
    assert.equal(started, true);
});

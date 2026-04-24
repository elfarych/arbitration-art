import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

const payload = {
    runtime_config_id: 1,
    owner_id: 1,
    config: {
        id: 1,
        name: 'counter-test',
        primary_exchange: 'binance',
        secondary_exchange: 'bybit',
        use_testnet: true,
        trade_amount_usdt: 50,
        leverage: 10,
        max_concurrent_trades: 1,
        top_liquid_pairs_count: 10,
        max_trade_duration_minutes: 60,
        max_leg_drawdown_percent: 80,
        open_threshold: 2,
        close_threshold: 1,
        orderbook_limit: 50,
        chunk_size: 10,
        is_active: true,
    },
    keys: {},
};

test('TradeCounter reserves and releases slots without going negative', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const { TradeCounter } = await import('../src/classes/TradeCounter.js');

    setActiveRuntime(payload);
    const counter = new TradeCounter();

    assert.equal(counter.reserve(), true);
    assert.equal(counter.reserve(), false);
    assert.equal(counter.current, 1);
    counter.release();
    counter.release();
    assert.equal(counter.current, 0);

    clearActiveRuntime();
});

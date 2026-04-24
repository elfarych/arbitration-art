import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

const payload = {
    runtime_config_id: 1,
    owner_id: 1,
    config: {
        id: 1,
        name: 'signal-test',
        primary_exchange: 'binance',
        secondary_exchange: 'bybit',
        use_testnet: true,
        trade_amount_usdt: 50,
        leverage: 10,
        max_concurrent_trades: 3,
        top_liquid_pairs_count: 10,
        max_trade_duration_minutes: 60,
        max_leg_drawdown_percent: 80,
        open_threshold: 2,
        close_threshold: 1,
        orderbook_limit: 50,
        chunk_size: 10,
        is_active: true,
        entry_fee_buffer_percent: 0.2,
        entry_slippage_buffer_percent: 0.05,
        latency_buffer_percent: 0.02,
        funding_buffer_percent: 0,
        min_open_net_edge_percent: 0,
    },
    keys: {},
};

const marketInfo = {
    symbol: 'BTC/USDT:USDT',
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
    tradeAmount: 0.01,
    primaryFundingRate: null,
    secondaryFundingRate: null,
    primaryNextFundingTime: null,
    secondaryNextFundingTime: null,
    tradeable: true,
};

test('SignalEngine blocks relative expansion when net edge stays negative', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const { SignalEngine } = await import('../src/services/signal-engine.js');

    setActiveRuntime(payload);
    const engine = new SignalEngine();
    const evaluation = engine.evaluateEntry(
        { primaryBid: 96, primaryAsk: 100, secondaryBid: 97, secondaryAsk: 101 },
        marketInfo,
        -5,
        -5,
    );

    assert.equal(evaluation.decision, null);
    clearActiveRuntime();
});

test('SignalEngine emits entry when relative and economic thresholds pass', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const { SignalEngine } = await import('../src/services/signal-engine.js');

    setActiveRuntime(payload);
    const engine = new SignalEngine();
    const evaluation = engine.evaluateEntry(
        { primaryBid: 100, primaryAsk: 100, secondaryBid: 104, secondaryAsk: 105 },
        marketInfo,
        1,
        1,
    );

    assert.equal(evaluation.decision?.orderType, 'buy');
    assert.ok((evaluation.decision?.expectedNetEdge ?? 0) > 0);
    clearActiveRuntime();
});

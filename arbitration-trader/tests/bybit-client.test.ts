import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

const runtimePayload = {
    runtime_config_id: 1,
    owner_id: 1,
    config: {
        id: 1,
        name: 'bybit-client-test',
        primary_exchange: 'bybit',
        secondary_exchange: 'gate',
        use_testnet: true,
        trade_amount_usdt: 10,
        leverage: 3,
        max_concurrent_trades: 1,
        top_liquid_pairs_count: 5,
        max_trade_duration_minutes: 15,
        max_leg_drawdown_percent: 80,
        open_threshold: 4,
        close_threshold: 2,
        orderbook_limit: 50,
        chunk_size: 5,
        is_active: true,
    },
    keys: {},
};

test('BybitClient treats unified-account isolated margin switch rejection as non-fatal', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const { BybitClient } = await import('../src/exchanges/bybit-client.js');

    setActiveRuntime(runtimePayload);
    const client = new BybitClient({
        apiKey: 'test-key',
        secret: 'test-secret',
        useTestnet: true,
    }) as any;
    client.request = async () => {
        throw new Error('Bybit API Error 100028: unified account is forbidden');
    };

    await assert.doesNotReject(() => client.setIsolatedMargin('BTC/USDT:USDT'));
    clearActiveRuntime();
});

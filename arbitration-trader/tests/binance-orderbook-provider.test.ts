import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('BinanceOrderBookProvider blocks stale synced snapshots', async () => {
    const { BinanceOrderBookProvider } = await import('../src/exchanges/ws/binance-orderbook-provider.js');
    const provider = new BinanceOrderBookProvider({
        useTestnet: true,
        depthLimit: 5,
        maxStaleMs: 0,
    });

    const store = (provider as any).store;
    store.applySnapshot(
        'BTC/USDT:USDT',
        [[100, 1]],
        [[101, 1]],
        1,
        1,
    );

    await new Promise(resolve => setTimeout(resolve, 1));

    assert.equal(provider.getOrderBook('BTC/USDT:USDT'), null);
});

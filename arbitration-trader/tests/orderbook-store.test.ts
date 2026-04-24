import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookStore } from '../src/exchanges/ws/orderbook-store.js';

test('OrderBookStore returns cached sorted top levels and prunes stale depth', () => {
    const store = new OrderBookStore(2);
    store.applySnapshot(
        'BTC/USDT:USDT',
        [[99, 1], [100, 1]],
        [[102, 1], [101, 1]],
        1,
        1000,
    );

    store.applyAbsoluteDelta(
        'BTC/USDT:USDT',
        [[98, 1], [101, 1], [97, 1]],
        [[103, 1], [100, 1], [104, 1]],
        2,
        1001,
    );

    const book = store.getOrderBook('BTC/USDT:USDT');
    assert.deepEqual(book?.bids, [[101, 1], [100, 1]]);
    assert.deepEqual(book?.asks, [[100, 1], [101, 1]]);
});

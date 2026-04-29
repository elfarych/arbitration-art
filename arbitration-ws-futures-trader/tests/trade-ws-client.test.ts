import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('Binance WS signing keeps signature out of the signed payload', async () => {
    const { signBinanceParams } = await import('../src/exchanges/binance-usdm/binance-usdm-trade-ws.js');

    const first = signBinanceParams({
        symbol: 'BTCUSDT',
        side: 'BUY',
        timestamp: 1,
        signature: 'ignored',
    }, 'secret');
    const second = signBinanceParams({
        side: 'BUY',
        symbol: 'BTCUSDT',
        timestamp: 1,
    }, 'secret');

    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
});

test('runtime error sanitizer redacts sensitive payload fragments', async () => {
    const { sanitizeErrorText } = await import('../src/django-sync/runtime-error-reporter.js');

    const sanitized = sanitizeErrorText('failed apiKey=abc secret=def token=ghi {"signature":"xyz"}');
    assert.equal(sanitized.includes('abc'), false);
    assert.equal(sanitized.includes('def'), false);
    assert.equal(sanitized.includes('ghi'), false);
    assert.equal(sanitized.includes('xyz'), false);
});

test('order intents send exchange symbol to trade WebSocket clients', async () => {
    const { createOpenIntents } = await import('../src/execution/order-intent.js');

    const intents = createOpenIntents({
        localTradeId: 'local-1',
        primaryExchange: 'binance',
        secondaryExchange: 'bybit',
        symbol: 'BTC/USDT:USDT',
        direction: 'buy',
        quantity: 0.001,
    });

    assert.equal(intents.primary.symbol, 'BTCUSDT');
    assert.equal(intents.secondary.symbol, 'BTCUSDT');
});

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_MAX_AGE_MS = '10_000';
process.env.ORDERBOOK_MAX_SKEW_MS = '10_000';

test('numeric env values accept underscore separators', async () => {
    const { appConfig } = await import('../src/config.js');

    assert.equal(appConfig.orderbookMaxAgeMs, 10_000);
    assert.equal(appConfig.orderbookMaxSkewMs, 10_000);
});

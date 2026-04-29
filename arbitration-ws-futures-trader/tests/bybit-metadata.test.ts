import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_MAX_AGE_MS ||= '2000';
process.env.ORDERBOOK_MAX_SKEW_MS ||= '1000';
process.env.BYBIT_RECV_WINDOW_MS ||= '15000';

test('Bybit unified account margin-mode error is ignored during setup', async () => {
    const { isIgnorableMarginModeResponse } = await import('../src/exchanges/bybit-linear/bybit-linear-metadata.js');

    assert.equal(isIgnorableMarginModeResponse(10001, 'unified account is forbidden'), true);
    assert.equal(isIgnorableMarginModeResponse(110025, 'Position mode is not modified'), true);
    assert.equal(isIgnorableMarginModeResponse(110043, 'leverage not modified'), true);
    assert.equal(isIgnorableMarginModeResponse(10001, 'invalid symbol'), false);
});

test('Bybit private REST uses server time offset and configured recv window', async () => {
    const { BybitLinearMetadata } = await import('../src/exchanges/bybit-linear/bybit-linear-metadata.js');
    const originalFetch = globalThis.fetch;
    const requestHeaders: Array<Record<string, string>> = [];
    const serverTimeMs = Date.now() + 8_000;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v5/market/time')) {
            return jsonResponse({
                retCode: 0,
                retMsg: 'OK',
                result: {
                    timeSecond: String(Math.floor(serverTimeMs / 1000)),
                    timeNano: String(serverTimeMs * 1_000_000),
                },
            });
        }

        if (url.startsWith('https://api.bybit.com/v5/position/list')) {
            requestHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
            return jsonResponse({
                retCode: 0,
                retMsg: 'OK',
                result: { list: [], nextPageCursor: '' },
            });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    try {
        const metadata = new BybitLinearMetadata({
            apiKey: 'key',
            apiSecret: 'secret',
            useTestnet: false,
        });
        await metadata.fetchOpenPositions(['BTC/USDT:USDT']);

        assert.equal(requestHeaders.length, 1);
        assert.equal(requestHeaders[0]?.['x-bapi-recv-window'], '15000');
        const signedTimestamp = Number(requestHeaders[0]?.['x-bapi-timestamp']);
        assert.ok(Math.abs(signedTimestamp - serverTimeMs) < 1000);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_MAX_AGE_MS ||= '2000';
process.env.ORDERBOOK_MAX_SKEW_MS ||= '1000';

test('diagnostic order size is raised to exchange minimums', async () => {
    const { calculateDiagnosticOrderSize } = await import('../src/execution/test-trade-runner.js');

    const size = calculateDiagnosticOrderSize(10, 100_000, 0.001, 0.001, 50);

    assert.equal(size.quantity, 0.001);
    assert.equal(size.amountUsdt, 100);
});

test('diagnostic order size keeps larger requested amount', async () => {
    const { calculateDiagnosticOrderSize } = await import('../src/execution/test-trade-runner.js');

    const size = calculateDiagnosticOrderSize(250, 100_000, 0.001, 0.001, 50);

    assert.equal(size.quantity, 0.002);
    assert.equal(size.amountUsdt, 200);
});

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('spread, PnL and quantity rounding keep arbitration-trader semantics', async () => {
    const math = await import('../src/utils/math.js');

    assert.equal(math.calculateOpenSpread({
        primaryBid: 100,
        primaryAsk: 101,
        secondaryBid: 105,
        secondaryAsk: 106,
    }, 'buy'), (105 - 101) / 101 * 100);

    assert.equal(math.calculateOpenSpread({
        primaryBid: 110,
        primaryAsk: 111,
        secondaryBid: 100,
        secondaryAsk: 102,
    }, 'sell'), (110 - 102) / 102 * 100);

    assert.equal(math.roundDownToStep(1.239, 0.01), 1.23);
    assert.equal(math.commonDecimalStep(0.001, 0.01), 0.01);

    const pnl = math.calculateRealPnL(100, 105, 103, 101, 1, 'buy', 0.1);
    assert.equal(Number(pnl.profitUsdt.toFixed(8)), 6.9);
    assert.ok(pnl.profitPercentage > 0);
});

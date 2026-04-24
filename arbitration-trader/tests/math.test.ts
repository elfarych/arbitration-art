import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateOpenSpread,
    calculateRealPnL,
    calculateRealPnLByLegSizes,
    calculateTruePnL,
    calculateVWAP,
    checkLegDrawdown,
    commonDecimalStep,
    decimalPlaces,
    roundDownToStep,
} from '../src/utils/math.js';

test('calculateOpenSpread returns directional spread', () => {
    const prices = {
        primaryBid: 101,
        primaryAsk: 102,
        secondaryBid: 104,
        secondaryAsk: 105,
    };

    assert.equal(Number(calculateOpenSpread(prices, 'buy').toFixed(6)), 1.960784);
    assert.equal(Number(calculateOpenSpread(prices, 'sell').toFixed(6)), -3.809524);
});

test('calculateTruePnL includes signal-level fee estimate', () => {
    const pnl = calculateTruePnL(
        { pOpen: 100, sOpen: 103 },
        { primaryBid: 102, primaryAsk: 103, secondaryBid: 101, secondaryAsk: 102 },
        'buy',
    );

    assert.equal(Number(pnl.toFixed(6)), 2.8);
});

test('calculateRealPnL subtracts real commissions', () => {
    const result = calculateRealPnL(100, 103, 102, 101, 2, 'buy', 0.5);

    assert.equal(result.profitUsdt, 7.5);
    assert.equal(result.profitPercentage, 3.75);
});

test('calculateRealPnLByLegSizes supports mismatched leg sizes', () => {
    const result = calculateRealPnLByLegSizes(100, 103, 102, 101, 2, 1, 'buy', 0.5);

    assert.equal(result.profitUsdt, 5.5);
    assert.equal(result.profitPercentage, 2.75);
});

test('calculateVWAP rejects insufficient non-emergency depth', () => {
    assert.equal(Number.isNaN(calculateVWAP([[100, 1]], 2)), true);
    assert.equal(calculateVWAP([[100, 1]], 2, true), 100);
});

test('checkLegDrawdown returns worst leveraged losing leg', () => {
    const drawdown = checkLegDrawdown(
        { pOpen: 100, sOpen: 100 },
        { primaryBid: 95, primaryAsk: 96, secondaryBid: 102, secondaryAsk: 103 },
        'buy',
        10,
    );

    assert.equal(drawdown, 50);
});

test('decimal lot helpers support non-power-of-ten and non-divisible steps', () => {
    assert.equal(decimalPlaces(0.0005), 4);
    assert.equal(commonDecimalStep(0.002, 0.003), 0.006);
    assert.equal(roundDownToStep(1.2349, 0.0005), 1.2345);
});

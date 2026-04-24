import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAccountPositionsReconciled } from '../src/services/account-reconciliation.js';
import type { IExchangeClient } from '../src/exchanges/exchange-client.js';
import type { ExchangePosition, RuntimeCommandPayload, TradeRecord } from '../src/types/index.js';

const payload: RuntimeCommandPayload = {
    runtime_config_id: 7,
    owner_id: 3,
    config: {
        id: 7,
        name: 'runtime',
        primary_exchange: 'binance',
        secondary_exchange: 'bybit',
        use_testnet: true,
        trade_amount_usdt: 50,
        leverage: 10,
        max_concurrent_trades: 1,
        top_liquid_pairs_count: 10,
        max_trade_duration_minutes: 60,
        max_leg_drawdown_percent: 80,
        open_threshold: 2,
        close_threshold: 1,
        orderbook_limit: 50,
        chunk_size: 10,
        is_active: true,
    },
    keys: {},
};

const openTrade: TradeRecord = {
    id: 101,
    runtime_config: 7,
    coin: 'BTC/USDT:USDT',
    primary_exchange: 'binance_futures',
    secondary_exchange: 'bybit_futures',
    order_type: 'buy',
    status: 'open',
    amount: 0.01,
    leverage: 10,
    primary_open_price: '100000',
    secondary_open_price: '100020',
    primary_open_order_id: 'p-1',
    secondary_open_order_id: 's-1',
    open_spread: '0.02',
    open_commission: '0.1',
    opened_at: new Date().toISOString(),
};

test('account reconciliation accepts positions matching Django open trades', async () => {
    await assertAccountPositionsReconciled({
        payload,
        primaryClient: fakeClient('Binance', [{ symbol: openTrade.coin, side: 'long', amount: 0.010005 }]),
        secondaryClient: fakeClient('Bybit', [{ symbol: openTrade.coin, side: 'short', amount: 0.01 }]),
        openTrades: [openTrade],
        sizeTolerancePercent: 0.1,
    });
});

test('account reconciliation rejects unexpected account positions', async () => {
    await assert.rejects(
        () => assertAccountPositionsReconciled({
            payload,
            primaryClient: fakeClient('Binance', [
                { symbol: openTrade.coin, side: 'long', amount: 0.01 },
                { symbol: 'ETH/USDT:USDT', side: 'long', amount: 1 },
            ]),
            secondaryClient: fakeClient('Bybit', [{ symbol: openTrade.coin, side: 'short', amount: 0.01 }]),
            openTrades: [openTrade],
            sizeTolerancePercent: 0.1,
        }),
        /unexpected long position ETH\/USDT:USDT/,
    );
});

test('account reconciliation rejects side and size mismatches', async () => {
    await assert.rejects(
        () => assertAccountPositionsReconciled({
            payload,
            primaryClient: fakeClient('Binance', [{ symbol: openTrade.coin, side: 'short', amount: 0.02 }]),
            secondaryClient: fakeClient('Bybit', [{ symbol: openTrade.coin, side: 'short', amount: 0.01 }]),
            openTrades: [openTrade],
            sizeTolerancePercent: 0.1,
        }),
        /side mismatch/,
    );

    await assert.rejects(
        () => assertAccountPositionsReconciled({
            payload,
            primaryClient: fakeClient('Binance', [{ symbol: openTrade.coin, side: 'long', amount: 0.02 }]),
            secondaryClient: fakeClient('Bybit', [{ symbol: openTrade.coin, side: 'short', amount: 0.01 }]),
            openTrades: [openTrade],
            sizeTolerancePercent: 0.1,
        }),
        /amount mismatch/,
    );
});

test('account reconciliation rejects opposite extra position on an expected symbol', async () => {
    await assert.rejects(
        () => assertAccountPositionsReconciled({
            payload,
            primaryClient: fakeClient('Binance', [
                { symbol: openTrade.coin, side: 'long', amount: 0.01 },
                { symbol: openTrade.coin, side: 'short', amount: 0.005 },
            ]),
            secondaryClient: fakeClient('Bybit', [{ symbol: openTrade.coin, side: 'short', amount: 0.01 }]),
            openTrades: [openTrade],
            sizeTolerancePercent: 0.1,
        }),
        /unexpected short position BTC\/USDT:USDT/,
    );
});

function fakeClient(name: string, positions: Array<Pick<ExchangePosition, 'symbol' | 'side' | 'amount'>>): IExchangeClient {
    const fullPositions: ExchangePosition[] = positions.map(position => ({
        ...position,
        contracts: position.amount,
        entryPrice: 1,
        raw: {},
    }));

    return {
        name,
        fetchAllOpenPositions: async () => fullPositions,
        fetchPositions: async () => fullPositions,
        fetchTime: async () => Date.now(),
        fetchTickers: async () => ({}),
        loadMarkets: async () => {},
        setLeverage: async () => {},
        setIsolatedMargin: async () => {},
        createMarketOrder: async () => {
            throw new Error('not implemented');
        },
        getMarketInfo: () => null,
        getUsdtSymbols: () => [],
        pingPrivate: async () => {},
        validateAccountMode: async () => {},
    };
}

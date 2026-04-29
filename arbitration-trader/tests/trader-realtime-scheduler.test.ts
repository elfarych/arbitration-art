import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_PAIR_MAX_AGE_MS = '2000';
process.env.ORDERBOOK_PAIR_MAX_SKEW_MS = '1000';
process.env.EXECUTION_JOURNAL_PATH ||= 'logs/test-execution-journal.jsonl';

const symbol = 'BTC/USDT:USDT';

function createProvider(snapshot: any = null) {
    return {
        exchange: 'mock',
        connect: async () => {},
        subscribe: async () => {},
        unsubscribe: async () => {},
        getOrderBook: () => snapshot,
        onUpdate: () => () => {},
        close: async () => {},
    };
}

function createSnapshot(primaryAsk: number, primaryBid: number, secondaryAsk = primaryAsk, secondaryBid = primaryBid) {
    const now = Date.now();
    return {
        primary: {
            symbol,
            bids: [[primaryBid, 10]],
            asks: [[primaryAsk, 10]],
            exchangeTimestamp: now,
            localTimestamp: now,
            sequence: 1,
            isSynced: true,
        },
        secondary: {
            symbol,
            bids: [[secondaryBid, 10]],
            asks: [[secondaryAsk, 10]],
            exchangeTimestamp: now,
            localTimestamp: now,
            sequence: 1,
            isSynced: true,
        },
    };
}

function createTrader(primaryProvider: any, secondaryProvider: any) {
    return new TraderCtor(
        1,
        [symbol],
        primaryProvider,
        secondaryProvider,
        {} as any,
        {} as any,
        {
            getInfo: () => ({
                symbol,
                stepSize: 0.001,
                minQty: 0.001,
                minNotional: 5,
                tradeAmount: 1,
                primaryFundingRate: null,
                secondaryFundingRate: null,
                primaryNextFundingTime: null,
                secondaryNextFundingTime: null,
                tradeable: true,
            }),
        } as any,
        {} as any,
        {} as any,
    );
}

function createRuntimePayload() {
    return {
        runtime_config_id: 1,
        owner_id: 1,
        config: {
            id: 1,
            name: 'trader-fast-path-test',
            primary_exchange: 'binance',
            secondary_exchange: 'bybit',
            use_testnet: true,
            trade_amount_usdt: 100,
            leverage: 3,
            max_concurrent_trades: 2,
            top_liquid_pairs_count: 10,
            max_trade_duration_minutes: 30,
            max_leg_drawdown_percent: 80,
            open_threshold: 1,
            close_threshold: 1,
            orderbook_limit: 50,
            chunk_size: 10,
            is_active: true,
            entry_fee_buffer_percent: 0.1,
            entry_slippage_buffer_percent: 0,
            latency_buffer_percent: 0,
            funding_buffer_percent: 0,
            min_open_net_edge_percent: 0.5,
        },
        keys: {},
    };
}

function createMockExchangeClient(name: string) {
    const calls = {
        fetchPositions: 0,
        submitMarketOrder: 0,
        confirmOrderResult: 0,
    };

    const client = {
        name,
        fetchTime: async () => Date.now(),
        fetchTickers: async () => ({}),
        fetchPositions: async () => {
            calls.fetchPositions += 1;
            return [];
        },
        fetchAllOpenPositions: async () => [],
        loadMarkets: async () => {},
        setLeverage: async () => {},
        setIsolatedMargin: async () => {},
        createMarketOrder: async (orderSymbol: string, side: 'buy' | 'sell', amount: number, params: any = {}) => {
            const submission = await client.submitMarketOrder(orderSymbol, side, amount, params);
            return client.confirmOrderResult(submission);
        },
        submitMarketOrder: async (orderSymbol: string, side: 'buy' | 'sell', amount: number, params: any = {}) => {
            calls.submitMarketOrder += 1;
            const now = Date.now();
            return {
                symbol: orderSymbol,
                side,
                amount,
                reduceOnly: Boolean(params.reduceOnly),
                orderId: `${name}-${calls.submitMarketOrder}`,
                clientOrderId: `${name}-client-${calls.submitMarketOrder}`,
                submittedAtMs: now,
                acknowledgedAtMs: now + 1,
                raw: {},
            };
        },
        confirmOrderResult: async (submission: any) => {
            calls.confirmOrderResult += 1;
            return {
                orderId: submission.orderId,
                avgPrice: submission.side === 'buy' ? 100 : 104,
                filledQty: submission.amount,
                commission: 0,
                commissionAsset: 'USDT',
                status: 'closed',
                raw: {},
            };
        },
        getMarketInfo: () => null,
        getUsdtSymbols: () => [symbol],
        pingPrivate: async () => {},
        validateAccountMode: async () => {},
    };

    return { client, calls };
}

function createFastPathTrader(primaryProvider: any, secondaryProvider: any, primaryClient: any, secondaryClient: any) {
    return new TraderCtor(
        1,
        [symbol],
        primaryProvider,
        secondaryProvider,
        primaryClient,
        secondaryClient,
        {
            getInfo: () => ({
                symbol,
                stepSize: 0.001,
                minQty: 0.001,
                minNotional: 5,
                tradeAmount: 1,
                primaryFundingRate: null,
                secondaryFundingRate: null,
                primaryNextFundingTime: null,
                secondaryNextFundingTime: null,
                tradeable: true,
            }),
        } as any,
        {
            canOpen: () => true,
            reserve: () => true,
            release: () => {},
            forceReserve: () => {},
        } as any,
        {
            isLocked: false,
            lock: () => {},
            clear: () => {},
        } as any,
    );
}

let TraderCtor: any;

test.before(async () => {
    const module = await import('../src/classes/Trader.js');
    TraderCtor = module.Trader;
});

test('Trader reruns a symbol check once with the latest update after an in-flight check finishes', async () => {
    const trader = createTrader(createProvider(), createProvider()) as any;
    let calls = 0;

    trader.checkSpreads = async () => {
        calls += 1;
        if (calls === 1) {
            trader.scheduleCheck(symbol, Date.now());
            trader.scheduleCheck(symbol, Date.now());
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };

    trader.scheduleCheck(symbol, Date.now());
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(calls, 2);
});

test('Trader rejects stale or skewed orderbook pairs before price calculation', () => {
    const now = Date.now();
    const freshSnapshot = {
        symbol,
        bids: [[100, 2]],
        asks: [[101, 2]],
        exchangeTimestamp: now,
        localTimestamp: now,
        sequence: 1,
        isSynced: true,
    };
    const staleSnapshot = {
        ...freshSnapshot,
        localTimestamp: now - 10_000,
    };
    const traderWithStaleBook = createTrader(
        createProvider(freshSnapshot),
        createProvider(staleSnapshot),
    ) as any;

    assert.equal(traderWithStaleBook.getPrices(symbol, 1, false), null);

    const traderWithFreshBooks = createTrader(
        createProvider(freshSnapshot),
        createProvider({ ...freshSnapshot, localTimestamp: now - 100 }),
    ) as any;

    assert.deepEqual(traderWithFreshBooks.getPrices(symbol, 1, false), {
        primaryBid: 100,
        primaryAsk: 101,
        secondaryBid: 100,
        secondaryAsk: 101,
    });
});

test('Trader entry fast path submits orders without pre-entry position fetch', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const { api } = await import('../src/services/api.js');
    const snapshots = createSnapshot(100, 99, 105, 104);
    const primary = createMockExchangeClient('primary');
    const secondary = createMockExchangeClient('secondary');
    const trader = createFastPathTrader(
        createProvider(snapshots.primary),
        createProvider(snapshots.secondary),
        primary.client,
        secondary.client,
    ) as any;

    setActiveRuntime(createRuntimePayload());
    const originalOpenTrade = api.openTrade;
    (api as any).openTrade = async (payload: any) => ({
        id: 1,
        runtime_config: payload.runtime_config,
        coin: payload.coin,
        primary_exchange: payload.primary_exchange,
        secondary_exchange: payload.secondary_exchange,
        order_type: payload.order_type,
        status: 'open',
        amount: payload.amount,
        leverage: payload.leverage,
        primary_open_price: String(payload.primary_open_price),
        secondary_open_price: String(payload.secondary_open_price),
        primary_open_order_id: payload.primary_open_order_id,
        secondary_open_order_id: payload.secondary_open_order_id,
        open_spread: String(payload.open_spread),
        open_commission: String(payload.open_commission),
        opened_at: new Date().toISOString(),
    });

    try {
        await trader.executeOpen(
            symbol,
            trader.states.get(symbol),
            'buy',
            { primaryBid: 99, primaryAsk: 100, secondaryBid: 104, secondaryAsk: 105 },
            4,
            1,
            3.9,
            0,
            { marketEventAtMs: Date.now(), checkStartedAtMs: Date.now(), signalDetectedAtMs: Date.now() },
        );

        assert.equal(primary.calls.fetchPositions, 0);
        assert.equal(secondary.calls.fetchPositions, 0);
        assert.equal(primary.calls.submitMarketOrder, 1);
        assert.equal(secondary.calls.submitMarketOrder, 1);
    } finally {
        (api as any).openTrade = originalOpenTrade;
        clearActiveRuntime();
    }
});

test('Trader entry final recheck rejects disappeared edge before order submit', async () => {
    const { setActiveRuntime, clearActiveRuntime } = await import('../src/config.js');
    const snapshots = createSnapshot(100, 99, 100.2, 100.1);
    const primary = createMockExchangeClient('primary');
    const secondary = createMockExchangeClient('secondary');
    const trader = createFastPathTrader(
        createProvider(snapshots.primary),
        createProvider(snapshots.secondary),
        primary.client,
        secondary.client,
    ) as any;

    setActiveRuntime(createRuntimePayload());
    try {
        await trader.executeOpen(
            symbol,
            trader.states.get(symbol),
            'buy',
            { primaryBid: 99, primaryAsk: 100, secondaryBid: 104, secondaryAsk: 105 },
            4,
            1,
            3.9,
            0,
            { marketEventAtMs: Date.now(), checkStartedAtMs: Date.now(), signalDetectedAtMs: Date.now() },
        );

        assert.equal(primary.calls.fetchPositions, 0);
        assert.equal(secondary.calls.fetchPositions, 0);
        assert.equal(primary.calls.submitMarketOrder, 0);
        assert.equal(secondary.calls.submitMarketOrder, 0);
    } finally {
        clearActiveRuntime();
    }
});

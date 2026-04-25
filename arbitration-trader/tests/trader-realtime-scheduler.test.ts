import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';
process.env.ORDERBOOK_PAIR_MAX_AGE_MS = '2000';
process.env.ORDERBOOK_PAIR_MAX_SKEW_MS = '1000';

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

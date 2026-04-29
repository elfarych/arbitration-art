import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookStore } from '../src/market-data/orderbook-store.js';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('open submits both WS legs in parallel before persistence is enqueued', async () => {
    const { ExecutionEngine } = await import('../src/execution/execution-engine.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');
    const { LatencyMetricsStore } = await import('../src/execution/latency-metrics.js');

    const runtime = testRuntime();
    const store = testStore(runtime);
    const writer = new RecordingTradeWriter();
    const events = new RecordingEventWriter();
    const binance = new FakeTradeClient('binance', 40);
    const bybit = new FakeTradeClient('bybit', 40);
    const engine = new ExecutionEngine(
        runtime,
        store,
        testMarketInfo(),
        new Map([['binance', binance], ['bybit', bybit]]),
        writer,
        events,
        new RuntimeErrorReporter(1),
        new LatencyMetricsStore(),
    );

    const running = engine.onMarketUpdate('BTC/USDT:USDT');
    await sleep(10);

    assert.equal(binance.submits.length, 1);
    assert.equal(bybit.submits.length, 1);
    assert.equal(writer.opens.length, 0);
    assert.ok(Math.abs(binance.submits[0]!.sentAt - bybit.submits[0]!.sentAt) < 15);

    await running;
    assert.equal(writer.opens.length, 1);
    assert.equal(events.events[0]?.type, 'open_submitted');
    const openTiming = events.events.find(event => event.type === 'trade_timing' && event.phase === 'open');
    assert.equal(typeof openTiming?.actual_opened_at, 'number');
    assert.equal(typeof openTiming?.detection_to_actual_open_ms, 'number');
});

test('open submit rollback closes a filled leg when the second leg fails', async () => {
    const { ExecutionEngine } = await import('../src/execution/execution-engine.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');
    const { LatencyMetricsStore } = await import('../src/execution/latency-metrics.js');

    const runtime = testRuntime();
    const store = testStore(runtime);
    const writer = new RecordingTradeWriter();
    const events = new RecordingEventWriter();
    const binance = new FakeTradeClient('binance', 1);
    const bybit = new FakeTradeClient('bybit', 1, new Error('Bybit trade WebSocket closed.'));
    const engine = new ExecutionEngine(
        runtime,
        store,
        testMarketInfo(),
        new Map([['binance', binance], ['bybit', bybit]]),
        writer,
        events,
        new RuntimeErrorReporter(1),
        new LatencyMetricsStore(),
    );

    await engine.onMarketUpdate('BTC/USDT:USDT');

    assert.equal(writer.opens.length, 0);
    assert.equal(binance.submits.length, 2);
    assert.equal(bybit.submits.length, 1);
    assert.equal(binance.submits[1]?.intent.reduceOnly, true);
    assert.equal(binance.submits[1]?.intent.side, reverseSide(binance.submits[0]!.intent.side));
    assert.equal(engine.getState().riskLocked, true);
    assert.equal(engine.getState().activeTradeCount, 0);
    assert.equal(engine.getState().symbols.find(symbol => symbol.symbol === 'BTC/USDT:USDT')?.status, 'error_exposure');
    assert.ok(events.events.some(event => event.type === 'open_rollback_submitted' && event.succeeded === true));
    assert.ok(events.events.some(event => event.type === 'open_failed'));
});

test('profit close uses reduce-only WS submit without position reader dependency', async () => {
    const { ExecutionEngine } = await import('../src/execution/execution-engine.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');
    const { LatencyMetricsStore } = await import('../src/execution/latency-metrics.js');

    const runtime = testRuntime();
    const store = testStore(runtime);
    const writer = new RecordingTradeWriter();
    const events = new RecordingEventWriter();
    const binance = new FakeTradeClient('binance', 1);
    const bybit = new FakeTradeClient('bybit', 1);
    const engine = new ExecutionEngine(
        runtime,
        store,
        testMarketInfo(),
        new Map([['binance', binance], ['bybit', bybit]]),
        writer,
        events,
        new RuntimeErrorReporter(1),
        new LatencyMetricsStore(),
    );

    await engine.onMarketUpdate('BTC/USDT:USDT');
    assert.equal(writer.opens.length, 1);

    const now = Date.now();
    store.set(book('binance', 'BTC/USDT:USDT', [[105, 10]], [[106, 10]], now));
    store.set(book('bybit', 'BTC/USDT:USDT', [[99, 10]], [[100, 10]], now));
    await engine.onMarketUpdate('BTC/USDT:USDT');

    assert.equal(writer.closes.length, 1);
    assert.equal(binance.submits.at(-1)?.intent.reduceOnly, true);
    assert.equal(bybit.submits.at(-1)?.intent.reduceOnly, true);
    assert.equal(engine.getState().symbols.find(symbol => symbol.symbol === 'BTC/USDT:USDT')?.status, 'idle');
    const closeTiming = events.events.find(event => event.type === 'trade_timing' && event.phase === 'close');
    assert.equal(typeof closeTiming?.actual_closed_at, 'number');
    assert.equal(typeof closeTiming?.signal_to_actual_close_ms, 'number');
});

test('timeout close releases symbol after max trade duration', async () => {
    const { ExecutionEngine } = await import('../src/execution/execution-engine.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');
    const { LatencyMetricsStore } = await import('../src/execution/latency-metrics.js');

    const runtime = { ...testRuntime(), maxTradeDurationMs: 1, closeThreshold: 100 };
    const store = testStore(runtime);
    const writer = new RecordingTradeWriter();
    const events = new RecordingEventWriter();
    const binance = new FakeTradeClient('binance', 1);
    const bybit = new FakeTradeClient('bybit', 1);
    const engine = new ExecutionEngine(
        runtime,
        store,
        testMarketInfo(),
        new Map([['binance', binance], ['bybit', bybit]]),
        writer,
        events,
        new RuntimeErrorReporter(1),
        new LatencyMetricsStore(),
    );

    await engine.onMarketUpdate('BTC/USDT:USDT');
    assert.equal(writer.opens.length, 1);

    await sleep(5);
    const now = Date.now();
    store.set(book('binance', 'BTC/USDT:USDT', [[99, 10]], [[100, 10]], now));
    store.set(book('bybit', 'BTC/USDT:USDT', [[103, 10]], [[104, 10]], now));
    await engine.onMarketUpdate('BTC/USDT:USDT');

    assert.equal(writer.closes.length, 1);
    assert.equal(writer.closes[0]?.closeReason, 'timeout');
    assert.equal(engine.getState().symbols.find(symbol => symbol.symbol === 'BTC/USDT:USDT')?.status, 'idle');
});

test('timeout close does not require fresh orderbook pricing', async () => {
    const { ExecutionEngine } = await import('../src/execution/execution-engine.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');
    const { LatencyMetricsStore } = await import('../src/execution/latency-metrics.js');

    const runtime = { ...testRuntime(), maxTradeDurationMs: 1, closeThreshold: 100 };
    const store = testStore(runtime);
    const writer = new RecordingTradeWriter();
    const events = new RecordingEventWriter();
    const binance = new FakeTradeClient('binance', 1);
    const bybit = new FakeTradeClient('bybit', 1);
    const engine = new ExecutionEngine(
        runtime,
        store,
        testMarketInfo(),
        new Map([['binance', binance], ['bybit', bybit]]),
        writer,
        events,
        new RuntimeErrorReporter(1),
        new LatencyMetricsStore(),
    );

    await engine.onMarketUpdate('BTC/USDT:USDT');
    assert.equal(writer.opens.length, 1);

    await sleep(5);
    const stale = Date.now() - runtime.orderbookMaxAgeMs - 1000;
    store.set(book('binance', 'BTC/USDT:USDT', [[99, 10]], [[100, 10]], stale));
    store.set(book('bybit', 'BTC/USDT:USDT', [[103, 10]], [[104, 10]], stale));
    await engine.onMarketUpdate('BTC/USDT:USDT');

    assert.equal(writer.closes.length, 1);
    assert.equal(writer.closes[0]?.closeReason, 'timeout');
});

test('trade writer creates open record before close when close is queued first', async () => {
    const { AsyncTradeWriter } = await import('../src/persistence/async-trade-writer.js');
    const { RuntimeErrorReporter } = await import('../src/django-sync/runtime-error-reporter.js');

    const service = new FakeSyncService();
    const writer = new AsyncTradeWriter(testRuntime(), service as never, new RuntimeErrorReporter(1), 1);
    const activeTrade = sampleActiveTrade();
    writer.enqueueClose({
        activeTrade,
        primaryCloseExecution: sampleExecution('binance', 'close-b'),
        secondaryCloseExecution: sampleExecution('bybit', 'close-y'),
        primaryClosePrice: 101,
        secondaryClosePrice: 104,
        closeSpread: 1,
        closeCommission: 0,
        profitUsdt: 1,
        profitPercentage: 1,
        closeReason: 'profit',
        closedAt: new Date().toISOString(),
    });

    await writer.flushForTests();
    assert.deepEqual(service.calls, ['open:BTC/USDT:USDT', 'close:1']);
});

function testRuntime() {
    return {
        runtimeConfigId: 1,
        ownerId: 1,
        name: 'test',
        primaryExchange: 'binance' as const,
        secondaryExchange: 'bybit' as const,
        useTestnet: true,
        tradeAmountUsdt: 100,
        leverage: 5,
        maxConcurrentTrades: 2,
        topLiquidPairsCount: 10,
        maxTradeDurationMs: 60_000,
        maxLegDrawdownPercent: 80,
        openThreshold: 0,
        closeThreshold: 0.1,
        orderbookLimit: 20,
        orderbookMaxAgeMs: 5000,
        orderbookMaxSkewMs: 5000,
        maxTradeNotionalUsdt: 100,
    };
}

function testMarketInfo() {
    return new Map([['BTC/USDT:USDT', {
        symbol: 'BTC/USDT:USDT',
        stepSize: 0.001,
        minQty: 0.001,
        minNotional: 5,
        tradeAmount: 1,
    }]]);
}

function testStore(runtime: ReturnType<typeof testRuntime>) {
    const store = new OrderBookStore();
    const now = Date.now();
    store.set(book(runtime.primaryExchange, 'BTC/USDT:USDT', [[99, 10]], [[100, 10]], now));
    store.set(book(runtime.secondaryExchange, 'BTC/USDT:USDT', [[103, 10]], [[104, 10]], now));
    return store;
}

function book(exchange: 'binance' | 'bybit', symbol: string, bids: [number, number][], asks: [number, number][], ts: number) {
    return {
        exchange,
        symbol,
        bids,
        asks,
        exchangeTimestamp: ts,
        localTimestamp: ts,
        sequence: 1,
    };
}

class FakeTradeClient {
    readonly submits: Array<{ intent: import('../src/exchanges/exchange-types.js').OrderIntent; sentAt: number }> = [];

    constructor(
        readonly exchange: 'binance' | 'bybit',
        private readonly delayMs: number,
        private readonly failure: Error | null = null,
    ) {}

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    isReady(): boolean { return true; }
    onReadyChange(): () => void { return () => undefined; }

    async submitMarketOrder(intent: import('../src/exchanges/exchange-types.js').OrderIntent) {
        this.submits.push({ intent, sentAt: Date.now() });
        await sleep(this.delayMs);
        if (this.failure) {
            throw this.failure;
        }
        const price = intent.side === 'buy' ? 100 : 103;
        return sampleExecution(this.exchange, intent.clientOrderId, price, intent);
    }
}

class RecordingTradeWriter {
    readonly opens: object[] = [];
    readonly closes: Array<{ closeReason?: string }> = [];
    enqueueOpen(value: object): void { this.opens.push(value); }
    enqueueClose(value: { closeReason?: string }, onPersisted?: () => void): void {
        this.closes.push(value);
        onPersisted?.();
    }
}

class RecordingEventWriter {
    readonly events: Array<Record<string, unknown>> = [];
    enqueue(value: unknown): void {
        this.events.push(value && typeof value === 'object' ? value as Record<string, unknown> : { value });
    }
}

class FakeSyncService {
    readonly calls: string[] = [];
    async createOpenTrade(activeTrade: { symbol: string }) {
        this.calls.push(`open:${activeTrade.symbol}`);
        return { id: 1 };
    }
    async closeTrade(id: number) {
        this.calls.push(`close:${id}`);
        return { id };
    }
}

function sampleActiveTrade() {
    return {
        localTradeId: 'local-1',
        djangoTradeId: null,
        runtimeConfigId: 1,
        symbol: 'BTC/USDT:USDT',
        direction: 'buy' as const,
        quantity: 1,
        primaryExchange: 'binance' as const,
        secondaryExchange: 'bybit' as const,
        primaryOpenPrice: 100,
        secondaryOpenPrice: 103,
        primaryOpenOrderId: 'open-b',
        secondaryOpenOrderId: 'open-y',
        openSpread: 3,
        openCommission: 0,
        openedAt: new Date().toISOString(),
        openExecutions: {
            primary: sampleExecution('binance', 'open-b'),
            secondary: sampleExecution('bybit', 'open-y'),
        },
    };
}

function sampleExecution(
    exchange: 'binance' | 'bybit',
    id: string,
    avgPrice = 100,
    intent?: import('../src/exchanges/exchange-types.js').OrderIntent,
) {
    return {
        exchange,
        symbol: intent?.symbol ?? 'BTC/USDT:USDT',
        orderId: id,
        clientOrderId: intent?.clientOrderId ?? id,
        side: intent?.side ?? 'buy',
        quantity: intent?.quantity ?? 1,
        avgPrice,
        filledQty: intent?.quantity ?? 1,
        commission: 0,
        commissionAsset: 'USDT',
        acknowledgedAt: Date.now(),
        filledAt: Date.now(),
        raw: {},
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function reverseSide(side: 'buy' | 'sell'): 'buy' | 'sell' {
    return side === 'buy' ? 'sell' : 'buy';
}

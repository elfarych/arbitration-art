import { createHash } from 'node:crypto';
import type { ExchangeName, RuntimeCommandPayload } from '../config.js';
import { appConfig, mergeEnvKeys, normalizeRuntimePayload, type NormalizedRuntimeConfig } from '../config.js';
import type { MarketWsClient, SymbolMarketInfo, TradeWsClient, UnifiedMarketInfo } from '../exchanges/exchange-types.js';
import { BinanceUsdmMetadata } from '../exchanges/binance-usdm/binance-usdm-metadata.js';
import { BinanceUsdmMarketWs } from '../exchanges/binance-usdm/binance-usdm-market-ws.js';
import { BinanceUsdmTradeWs } from '../exchanges/binance-usdm/binance-usdm-trade-ws.js';
import { BybitLinearMetadata } from '../exchanges/bybit-linear/bybit-linear-metadata.js';
import { BybitLinearMarketWs } from '../exchanges/bybit-linear/bybit-linear-market-ws.js';
import { BybitLinearTradeWs } from '../exchanges/bybit-linear/bybit-linear-trade-ws.js';
import { commonDecimalStep, roundDownToStep } from '../utils/math.js';
import { OrderBookStore } from '../market-data/orderbook-store.js';
import { SymbolRouter } from '../market-data/symbol-router.js';
import { ExecutionEngine, type ExecutionEngineState, type RuntimeTradePnlSnapshot } from '../execution/execution-engine.js';
import { LatencyMetricsStore } from '../execution/latency-metrics.js';
import { AsyncTradeWriter } from '../persistence/async-trade-writer.js';
import { AsyncEventWriter, CompositeEventWriter } from '../persistence/async-event-writer.js';
import { TradeSyncService } from '../django-sync/trade-sync-service.js';
import { RuntimeErrorReporter } from '../django-sync/runtime-error-reporter.js';
import { BackgroundReconciliation } from '../recovery/background-reconciliation.js';
import { runTestTrade, type TestTradeRequest, type TestTradeResult } from '../execution/test-trade-runner.js';
import { sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';

export type RuntimeManagerStatus = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'risk_locked' | 'error';

export interface ExchangeHealthCheckResult {
    exchange: ExchangeName;
    available: boolean;
    error: string | null;
}

export interface RuntimeTradesDiagnostics {
    requested_runtime_config_id: number | null;
    active_runtime_config_id: number | null;
    is_requested_runtime_active: boolean;
    trade_count: number;
    active_coins: string[];
    trades: RuntimeTradePnlSnapshot[];
}

interface RuntimeHandle {
    runtime: NormalizedRuntimeConfig;
    payloadFingerprint: string;
    symbols: string[];
    store: OrderBookStore;
    router: SymbolRouter;
    execution: ExecutionEngine;
    tradeClients: TradeWsClient[];
    marketClients: MarketWsClient[];
    tradeWriter: AsyncTradeWriter;
    eventWriter: CompositeEventWriter;
    reconciliation: BackgroundReconciliation | null;
    stopTradeReconnects: Array<() => void>;
}

interface TradeReconnectState {
    stopped: boolean;
    running: boolean;
    attempts: number;
}

const TRADE_WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
const TRADE_WS_RECONNECT_MAX_DELAY_MS = 30_000;

export class RuntimeManager {
    private statusValue: RuntimeManagerStatus = 'idle';
    private active: RuntimeHandle | null = null;
    private readonly latencyMetrics = new LatencyMetricsStore();
    private lifecycleTail: Promise<void> = Promise.resolve();
    private lifecyclePendingCount = 0;
    private startOperations = new Map<string, Promise<void>>();
    private tradeWsAutoPaused = false;
    private startAbortController: AbortController | null = null;

    constructor(private readonly errorReporter: RuntimeErrorReporter) {}

    status(): RuntimeManagerStatus {
        if (this.active && this.statusValue !== 'stopping' && this.active.execution.getState().riskLocked) {
            return 'risk_locked';
        }
        return this.statusValue;
    }

    activeRuntimeConfigId(): number | null {
        return this.active?.runtime.runtimeConfigId ?? null;
    }

    latency(): unknown[] {
        return this.latencyMetrics.recent();
    }

    state(): ExecutionEngineState | { status: RuntimeManagerStatus } {
        if (!this.active) {
            return { status: this.statusValue };
        }
        return this.active.execution.getState();
    }

    getRuntimeDiagnosticsState(): {
        activeRuntimeConfigId: number | null;
        runtimeState: 'idle' | 'running' | 'risk_locked' | 'stopping_with_open_exposure';
        riskLocked: boolean;
    } {
        const state = this.active?.execution.getState();
        const riskLocked = state?.riskLocked ?? this.statusValue === 'risk_locked';
        return {
            activeRuntimeConfigId: this.activeRuntimeConfigId(),
            runtimeState: !this.active ? 'idle' : riskLocked ? 'risk_locked' : 'running',
            riskLocked,
        };
    }

    getActiveTradesDiagnostics(runtimeConfigId?: number): RuntimeTradesDiagnostics {
        const activeRuntimeConfigId = this.activeRuntimeConfigId();
        const isRequestedRuntimeActive = Boolean(
            this.active
            && (runtimeConfigId === undefined || runtimeConfigId === activeRuntimeConfigId),
        );

        if (!this.active || !isRequestedRuntimeActive) {
            return {
                requested_runtime_config_id: runtimeConfigId ?? null,
                active_runtime_config_id: activeRuntimeConfigId,
                is_requested_runtime_active: false,
                trade_count: 0,
                active_coins: [],
                trades: [],
            };
        }

        const trades = this.active.execution.getActiveTradeSnapshots();
        return {
            requested_runtime_config_id: runtimeConfigId ?? activeRuntimeConfigId,
            active_runtime_config_id: activeRuntimeConfigId,
            is_requested_runtime_active: true,
            trade_count: trades.length,
            active_coins: trades.map(trade => trade.coin),
            trades,
        };
    }

    async checkExchangeHealth(payload: RuntimeCommandPayload): Promise<{
        requested_runtime_config_id: number;
        active_runtime_config_id: number | null;
        exchanges: ExchangeHealthCheckResult[];
    }> {
        const runtime = normalizeRuntimePayload(payload, { enforceTradeAmountCap: false });
        const keys = mergeEnvKeys(payload.keys);
        const exchanges = [...new Set<ExchangeName>([runtime.primaryExchange, runtime.secondaryExchange])];
        const results = await Promise.all(exchanges.map(exchange => this.checkSingleExchangeHealth(exchange, runtime, keys)));
        return {
            requested_runtime_config_id: runtime.runtimeConfigId,
            active_runtime_config_id: this.activeRuntimeConfigId(),
            exchanges: results,
        };
    }

    async start(payload: RuntimeCommandPayload): Promise<void> {
        const fingerprint = runtimePayloadFingerprint(payload);
        const existingStart = this.startOperations.get(fingerprint);
        if (existingStart) {
            logger.info('RuntimeManager', `Start for runtime ${payload.runtime_config_id} is already in progress; joining existing start.`);
            return existingStart;
        }

        if (
            this.active?.payloadFingerprint === fingerprint
            && (this.statusValue === 'running' || this.statusValue === 'paused' || this.statusValue === 'risk_locked')
            && this.lifecyclePendingCount === 0
        ) {
            logger.info('RuntimeManager', `Runtime ${payload.runtime_config_id} is already active with the same payload; start is a no-op.`);
            return;
        }

        const operation = this.enqueueLifecycle(async () => this.startLocked(payload, fingerprint));
        this.startOperations.set(fingerprint, operation);
        try {
            await operation;
        } finally {
            if (this.startOperations.get(fingerprint) === operation) {
                this.startOperations.delete(fingerprint);
            }
        }
    }

    async runTestTrade(payload: RuntimeCommandPayload, request: TestTradeRequest = {}): Promise<TestTradeResult> {
        if (this.active || this.statusValue === 'starting' || this.startOperations.size > 0) {
            throw new Error('Stop the active runtime before running an isolated test trade.');
        }
        return runTestTrade(payload, request);
    }

    async stop(): Promise<void> {
        if (this.statusValue === 'starting' && this.startAbortController && !this.startAbortController.signal.aborted) {
            logger.info('RuntimeManager', 'Stop requested during startup; cancelling bootstrap.');
            this.startAbortController.abort();
        }
        await this.enqueueLifecycle(async () => this.stopLocked());
    }

    pause(): void {
        this.active?.execution.pause();
        this.tradeWsAutoPaused = false;
        this.statusValue = 'paused';
    }

    resume(): void {
        this.active?.execution.resume();
        this.tradeWsAutoPaused = false;
        this.statusValue = 'running';
    }

    private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
        this.lifecyclePendingCount += 1;
        const run = this.lifecycleTail.then(operation, operation).finally(() => {
            this.lifecyclePendingCount -= 1;
        });
        this.lifecycleTail = run.catch(() => undefined);
        return run;
    }

    private async startLocked(payload: RuntimeCommandPayload, fingerprint: string): Promise<void> {
        if (
            this.active?.payloadFingerprint === fingerprint
            && (this.statusValue === 'running' || this.statusValue === 'paused' || this.statusValue === 'risk_locked')
        ) {
            logger.info('RuntimeManager', `Runtime ${payload.runtime_config_id} is already active with the same payload; start is a no-op.`);
            return;
        }

        await this.stopLocked();
        this.statusValue = 'starting';
        const startAbortController = new AbortController();
        this.startAbortController = startAbortController;
        this.errorReporter.setRuntimeFromPayload(payload);
        logger.info('RuntimeManager', `Starting runtime ${payload.runtime_config_id}.`);

        let partialHandle: Partial<Pick<RuntimeHandle, 'router' | 'reconciliation' | 'tradeWriter' | 'eventWriter' | 'tradeClients' | 'marketClients' | 'stopTradeReconnects'>> = {};
        try {
            const runtime = normalizeRuntimePayload(payload);
            const keys = mergeEnvKeys(payload.keys);
            validateKeys(keys);
            throwIfStartCancelled(startAbortController.signal);
            logger.info(
                'RuntimeManager',
                `Runtime ${runtime.runtimeConfigId}: loading ${runtime.useTestnet ? 'testnet' : 'live'} market metadata.`,
            );

            const binanceMetadata = new BinanceUsdmMetadata({
                apiKey: keys.binance_api_key,
                apiSecret: keys.binance_secret,
                useTestnet: runtime.useTestnet,
            });
            const bybitMetadata = new BybitLinearMetadata({
                apiKey: keys.bybit_api_key,
                apiSecret: keys.bybit_secret,
                useTestnet: runtime.useTestnet,
            });

            const [binanceMarkets, bybitMarkets] = await Promise.all([
                binanceMetadata.loadMarketInfo(),
                bybitMetadata.loadMarketInfo(),
            ]);
            throwIfStartCancelled(startAbortController.signal);
            const symbols = selectSymbols(binanceMarkets, bybitMarkets, runtime);
            if (symbols.length === 0) {
                throw new Error('No shared Binance/Bybit USDT perpetual symbols are available.');
            }
            logger.info(
                'RuntimeManager',
                `Runtime ${runtime.runtimeConfigId}: selected ${symbols.length} symbols.`,
                { symbols: symbols.slice(0, 20), total: symbols.length },
            );

            const unifiedMarketInfo = buildUnifiedMarketInfo(symbols, binanceMarkets, bybitMarkets, runtime);
            logger.info('RuntimeManager', `Runtime ${runtime.runtimeConfigId}: preparing leverage/margin for ${symbols.length} symbols.`);
            await prepareLeverage(symbols, runtime, binanceMetadata, bybitMetadata, startAbortController.signal);
            throwIfStartCancelled(startAbortController.signal);

            const store = new OrderBookStore();
            const tradeClients = createTradeClients(runtime, keys);
            const marketClients = createMarketClients(runtime, store);
            partialHandle = { tradeClients, marketClients };
            logger.info('RuntimeManager', `Runtime ${runtime.runtimeConfigId}: connecting trade WebSockets.`);
            await Promise.all(tradeClients.map(client => client.connect()));
            throwIfStartCancelled(startAbortController.signal);

            const eventWriter = new CompositeEventWriter([
                new AsyncEventWriter(appConfig.asyncEventLogPath),
                new AsyncEventWriter(appConfig.recoveryMarkerPath),
            ]);
            partialHandle.eventWriter = eventWriter;
            const tradeWriter = new AsyncTradeWriter(
                runtime,
                new TradeSyncService(),
                this.errorReporter,
                appConfig.persistenceRetryDelayMs,
            );
            partialHandle.tradeWriter = tradeWriter;
            const tradeClientMap = new Map<ExchangeName, TradeWsClient>(tradeClients.map(client => [client.exchange, client]));
            const execution = new ExecutionEngine(
                runtime,
                store,
                unifiedMarketInfo,
                tradeClientMap,
                tradeWriter,
                eventWriter,
                this.errorReporter,
                this.latencyMetrics,
            );
            const router = new SymbolRouter(store, runtime, new Set(symbols), symbol => {
                void execution.onMarketUpdate(symbol);
            });
            partialHandle.router = router;

            const stopTradeReconnects = this.attachTradeReconnectHandlers(tradeClients, execution);
            partialHandle.stopTradeReconnects = stopTradeReconnects;

            logger.info('RuntimeManager', `Runtime ${runtime.runtimeConfigId}: connecting market data WebSockets.`);
            await Promise.all(marketClients.map(client => client.connect(symbols)));
            throwIfStartCancelled(startAbortController.signal);
            router.start();

            const reconciliation = appConfig.enableBackgroundReconciliation
                ? new BackgroundReconciliation([binanceMetadata, bybitMetadata], symbols, eventWriter, this.errorReporter)
                : null;
            partialHandle.reconciliation = reconciliation;
            reconciliation?.start();

            this.active = {
                runtime,
                payloadFingerprint: fingerprint,
                symbols,
                store,
                router,
                execution,
                tradeClients,
                marketClients,
                tradeWriter,
                eventWriter,
                reconciliation,
                stopTradeReconnects,
            };
            this.statusValue = 'running';
            this.tradeWsAutoPaused = false;
            logger.info('RuntimeManager', `Runtime ${runtime.runtimeConfigId} started with ${symbols.length} symbols.`);
        } catch (error) {
            if (error instanceof StartCancelledError) {
                this.statusValue = 'idle';
                this.tradeWsAutoPaused = false;
                await cleanupPartialStart(partialHandle);
                logger.info('RuntimeManager', `Runtime ${payload.runtime_config_id} startup cancelled.`);
                return;
            }
            this.statusValue = 'error';
            this.tradeWsAutoPaused = false;
            await cleanupPartialStart(partialHandle);
            const message = error instanceof Error ? error.message : String(error);
            logger.error('RuntimeManager', `Runtime ${payload.runtime_config_id} start failed: ${message}`);
            await this.errorReporter.report('start', message);
            throw error;
        } finally {
            if (this.startAbortController === startAbortController) {
                this.startAbortController = null;
            }
        }
    }

    private async stopLocked(): Promise<void> {
        const active = this.active;
        if (!active) {
            logger.info('RuntimeManager', 'Stop requested, but no runtime is active.');
            this.statusValue = 'idle';
            return;
        }

        this.statusValue = 'stopping';
        this.tradeWsAutoPaused = false;
        logger.info('RuntimeManager', `Stopping runtime ${active.runtime.runtimeConfigId}.`);
        for (const stopReconnect of active.stopTradeReconnects) {
            stopReconnect();
        }
        active.router.stop();
        active.reconciliation?.stop();
        active.tradeWriter.stop();
        active.eventWriter.stop();
        await Promise.allSettled([
            ...active.marketClients.map(client => client.close()),
            ...active.tradeClients.map(client => client.close()),
        ]);
        this.active = null;
        this.statusValue = 'idle';
        logger.info('RuntimeManager', `Runtime ${active.runtime.runtimeConfigId} stopped.`);
    }

    private attachTradeReconnectHandlers(
        tradeClients: TradeWsClient[],
        execution: ExecutionEngine,
    ): Array<() => void> {
        const stops: Array<() => void> = [];
        for (const client of tradeClients) {
            const reconnectState: TradeReconnectState = {
                stopped: false,
                running: false,
                attempts: 0,
            };
            const unsubscribe = client.onReadyChange(ready => {
                if (this.active?.execution !== execution || reconnectState.stopped) {
                    return;
                }

                if (!ready) {
                    execution.pause();
                    this.tradeWsAutoPaused = true;
                    this.statusValue = 'paused';
                    void this.errorReporter.report('runtime', `${client.exchange} trade WebSocket is not ready; trading paused.`);
                    void this.reconnectTradeClient(client, execution, tradeClients, reconnectState);
                    return;
                }

                reconnectState.attempts = 0;
                this.resumeAfterTradeWsRecovery(execution, tradeClients);
            });

            stops.push(() => {
                reconnectState.stopped = true;
                unsubscribe();
            });
        }
        return stops;
    }

    private async reconnectTradeClient(
        client: TradeWsClient,
        execution: ExecutionEngine,
        tradeClients: TradeWsClient[],
        state: TradeReconnectState,
    ): Promise<void> {
        if (state.running || state.stopped) {
            return;
        }

        state.running = true;
        try {
            while (
                !state.stopped
                && this.active?.execution === execution
                && !client.isReady()
            ) {
                state.attempts += 1;
                const delayMs = Math.min(
                    TRADE_WS_RECONNECT_MAX_DELAY_MS,
                    TRADE_WS_RECONNECT_INITIAL_DELAY_MS * (2 ** Math.min(state.attempts - 1, 5)),
                );
                logger.warn(
                    'RuntimeManager',
                    `${client.exchange} trade WebSocket is not ready; reconnect attempt ${state.attempts} in ${delayMs}ms.`,
                );
                await sleep(delayMs);

                if (state.stopped || this.active?.execution !== execution || client.isReady()) {
                    break;
                }

                try {
                    await client.connect();
                    logger.info('RuntimeManager', `${client.exchange} trade WebSocket reconnected.`);
                    state.attempts = 0;
                    this.resumeAfterTradeWsRecovery(execution, tradeClients);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn('RuntimeManager', `${client.exchange} trade WebSocket reconnect failed: ${message}`);
                    void this.errorReporter.report('runtime', `${client.exchange} trade WebSocket reconnect failed: ${message}`);
                }
            }
        } finally {
            state.running = false;
        }
    }

    private resumeAfterTradeWsRecovery(execution: ExecutionEngine, tradeClients: TradeWsClient[]): void {
        if (
            !this.tradeWsAutoPaused
            || this.active?.execution !== execution
            || !tradeClients.every(client => client.isReady())
        ) {
            return;
        }

        const state = execution.getState();
        if (state.riskLocked) {
            return;
        }

        execution.resume();
        this.tradeWsAutoPaused = false;
        this.statusValue = 'running';
        logger.info('RuntimeManager', 'Trade WebSockets recovered; runtime resumed.');
    }

    private async checkSingleExchangeHealth(
        exchange: ExchangeName,
        runtime: NormalizedRuntimeConfig,
        keys: Required<ReturnType<typeof mergeEnvKeys>>,
    ): Promise<ExchangeHealthCheckResult> {
        try {
            if (exchange === 'binance') {
                if (!keys.binance_api_key || !keys.binance_secret) {
                    throw new Error('Binance keys are required.');
                }
                await new BinanceUsdmMetadata({
                    apiKey: keys.binance_api_key,
                    apiSecret: keys.binance_secret,
                    useTestnet: runtime.useTestnet,
                }).fetchOpenPositions([]);
            } else {
                if (!keys.bybit_api_key || !keys.bybit_secret) {
                    throw new Error('Bybit keys are required.');
                }
                await new BybitLinearMetadata({
                    apiKey: keys.bybit_api_key,
                    apiSecret: keys.bybit_secret,
                    useTestnet: runtime.useTestnet,
                }).fetchOpenPositions([]);
            }
            return { exchange, available: true, error: null };
        } catch (error) {
            return {
                exchange,
                available: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}

function validateKeys(keys: Required<ReturnType<typeof mergeEnvKeys>>): void {
    if (!keys.binance_api_key || !keys.binance_secret) {
        throw new Error('Binance keys are required.');
    }
    if (!keys.bybit_api_key || !keys.bybit_secret) {
        throw new Error('Bybit keys are required.');
    }
}

async function cleanupPartialStart(
    handle: Partial<Pick<RuntimeHandle, 'router' | 'reconciliation' | 'tradeWriter' | 'eventWriter' | 'tradeClients' | 'marketClients' | 'stopTradeReconnects'>>,
): Promise<void> {
    for (const stopReconnect of handle.stopTradeReconnects ?? []) {
        stopReconnect();
    }
    handle.router?.stop();
    handle.reconciliation?.stop();
    handle.tradeWriter?.stop();
    handle.eventWriter?.stop();

    await Promise.allSettled([
        ...(handle.marketClients ?? []).map(client => client.close()),
        ...(handle.tradeClients ?? []).map(client => client.close()),
    ]);
}

function runtimePayloadFingerprint(payload: RuntimeCommandPayload): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(item => stableStringify(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
        return `{${entries.join(',')}}`;
    }

    return JSON.stringify(value);
}

function createTradeClients(runtime: NormalizedRuntimeConfig, keys: Required<ReturnType<typeof mergeEnvKeys>>): TradeWsClient[] {
    return [
        new BinanceUsdmTradeWs({
            apiKey: keys.binance_api_key,
            apiSecret: keys.binance_secret,
            useTestnet: runtime.useTestnet,
        }),
        new BybitLinearTradeWs({
            apiKey: keys.bybit_api_key,
            apiSecret: keys.bybit_secret,
            useTestnet: runtime.useTestnet,
        }),
    ];
}

function createMarketClients(runtime: NormalizedRuntimeConfig, store: OrderBookStore): MarketWsClient[] {
    return [
        new BinanceUsdmMarketWs(store, runtime.useTestnet, runtime.orderbookLimit),
        new BybitLinearMarketWs(store, runtime.useTestnet, runtime.orderbookLimit),
    ];
}

export function selectSymbols(
    binance: Map<string, SymbolMarketInfo>,
    bybit: Map<string, SymbolMarketInfo>,
    runtime: NormalizedRuntimeConfig,
): string[] {
    return [...binance.keys()]
        .filter(symbol => bybit.has(symbol))
        .sort((left, right) => {
            const priceChangeDiff =
                sharedPriceChangeScore(right, binance, bybit) - sharedPriceChangeScore(left, binance, bybit);
            if (priceChangeDiff !== 0) {
                return priceChangeDiff;
            }
            return sharedQuoteVolumeScore(right, binance, bybit) - sharedQuoteVolumeScore(left, binance, bybit);
        })
        .slice(0, runtime.topLiquidPairsCount);
}

function sharedPriceChangeScore(
    symbol: string,
    binance: Map<string, SymbolMarketInfo>,
    bybit: Map<string, SymbolMarketInfo>,
): number {
    return Math.min(
        Math.abs(finiteNumber(binance.get(symbol)?.priceChangePercent24h)),
        Math.abs(finiteNumber(bybit.get(symbol)?.priceChangePercent24h)),
    );
}

function sharedQuoteVolumeScore(
    symbol: string,
    binance: Map<string, SymbolMarketInfo>,
    bybit: Map<string, SymbolMarketInfo>,
): number {
    return Math.min(
        finiteNumber(binance.get(symbol)?.quoteVolume),
        finiteNumber(bybit.get(symbol)?.quoteVolume),
    );
}

function finiteNumber(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildUnifiedMarketInfo(
    symbols: string[],
    binance: Map<string, SymbolMarketInfo>,
    bybit: Map<string, SymbolMarketInfo>,
    runtime: NormalizedRuntimeConfig,
): Map<string, UnifiedMarketInfo> {
    const result = new Map<string, UnifiedMarketInfo>();
    for (const symbol of symbols) {
        const primary = runtime.primaryExchange === 'binance' ? binance.get(symbol) : bybit.get(symbol);
        const secondary = runtime.secondaryExchange === 'binance' ? binance.get(symbol) : bybit.get(symbol);
        if (!primary || !secondary) {
            continue;
        }
        const stepSize = commonDecimalStep(primary.stepSize, secondary.stepSize);
        const referencePrice = Math.max(1, primary.minNotional, secondary.minNotional);
        const roughQty = roundDownToStep(runtime.tradeAmountUsdt / referencePrice, stepSize);
        result.set(symbol, {
            symbol,
            stepSize,
            minQty: Math.max(primary.minQty, secondary.minQty),
            minNotional: Math.max(primary.minNotional, secondary.minNotional),
            tradeAmount: roughQty,
        });
    }
    return result;
}

async function prepareLeverage(
    symbols: string[],
    runtime: NormalizedRuntimeConfig,
    binance: BinanceUsdmMetadata,
    bybit: BybitLinearMetadata,
    signal: AbortSignal,
): Promise<void> {
    const failures: string[] = [];
    for (const [index, symbol] of symbols.entries()) {
        throwIfStartCancelled(signal);
        const [binanceResult, bybitResult] = await Promise.allSettled([
            retryLeverageSetup(() => binance.setLeverageAndMargin(symbol, runtime.leverage), 'binance', symbol, signal),
            retryLeverageSetup(() => bybit.setLeverageAndMargin(symbol, runtime.leverage), 'bybit', symbol, signal),
        ]);
        throwIfStartCancelled(signal);

        for (const [exchange, result] of [
            ['binance', binanceResult],
            ['bybit', bybitResult],
        ] as const) {
            if (result.status === 'rejected') {
                const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
                failures.push(`${exchange}:${symbol}:${message}`);
                logger.warn('RuntimeManager', `Leverage setup failed for ${exchange} ${symbol}: ${message}`);
            }
        }

        if ((index + 1) % 20 === 0 || index + 1 === symbols.length) {
            logger.info('RuntimeManager', `Leverage/margin setup progress: ${index + 1}/${symbols.length} symbols.`);
        }

        if (appConfig.leverageSetupDelayMs > 0 && index + 1 < symbols.length) {
            await sleepWithAbort(appConfig.leverageSetupDelayMs, signal);
        }
    }

    if (failures.length === 0) {
        return;
    }

    const summary = `Leverage/margin setup failed for ${failures.length} exchange-symbol pairs.`;
    if (appConfig.leverageSetupStrict) {
        throw new Error(`${summary} First failure: ${failures[0]}`);
    }
    logger.warn('RuntimeManager', `${summary} Continuing because LEVERAGE_SETUP_STRICT=false.`, {
        firstFailures: failures.slice(0, 10),
    });
}

async function retryLeverageSetup(
    operation: () => Promise<void>,
    exchange: ExchangeName,
    symbol: string,
    signal: AbortSignal,
): Promise<void> {
    const attempts = Math.max(1, Math.floor(appConfig.leverageSetupMaxRetries));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        throwIfStartCancelled(signal);
        try {
            await operation();
            return;
        } catch (error) {
            throwIfStartCancelled(signal);
            if (attempt >= attempts || !isRateLimitError(error)) {
                throw error;
            }
            const delayMs = appConfig.leverageSetupRetryDelayMs * attempt;
            logger.warn(
                'RuntimeManager',
                `Rate limit during leverage setup for ${exchange} ${symbol}; retry ${attempt + 1}/${attempts} in ${delayMs}ms.`,
            );
            await sleepWithAbort(delayMs, signal);
        }
    }
}

function isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return normalized.includes('rate limit')
        || normalized.includes('too many visits')
        || normalized.includes('too many requests');
}

class StartCancelledError extends Error {
    constructor() {
        super('Runtime startup was cancelled.');
        this.name = 'StartCancelledError';
    }
}

function throwIfStartCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new StartCancelledError();
    }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    throwIfStartCancelled(signal);
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        let cleanup: () => void = () => undefined;
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new StartCancelledError());
        };
        cleanup = () => signal.removeEventListener('abort', onAbort);
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
        timer.unref();
    });
}

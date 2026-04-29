import type { ExchangeName, NormalizedRuntimeConfig } from '../config.js';
import type { OrderBookSnapshot, OrderExecution, OrderIntent, TradeWsClient, UnifiedMarketInfo } from '../exchanges/exchange-types.js';
import { OrderBookStore } from '../market-data/orderbook-store.js';
import { createSymbolSignalState, type SymbolSignalState } from '../strategy/signal-state.js';
import { SpreadEngine } from '../strategy/spread-engine.js';
import { PnlEngine } from '../strategy/pnl-engine.js';
import { AsyncTradeWriter } from '../persistence/async-trade-writer.js';
import { AsyncEventWriter } from '../persistence/async-event-writer.js';
import { RuntimeErrorReporter } from '../django-sync/runtime-error-reporter.js';
import type { ActiveTrade, ClosedTrade } from './trade-state.js';
import { TradeCounter } from './trade-state.js';
import { createCloseIntents, createOpenIntents, executionPriceOrFallback } from './order-intent.js';
import { LatencyMetricsStore, type TradeLatencyMetrics } from './latency-metrics.js';
import { calculateOpenSpread, calculateVWAP, roundDownToStep, type OrderbookPrices } from '../utils/math.js';
import { logger } from '../utils/logger.js';

interface TradeWriterLike {
    enqueueOpen(activeTrade: ActiveTrade): void;
    enqueueClose(closedTrade: ClosedTrade, onPersisted?: () => void): void;
}

interface EventWriterLike {
    enqueue(event: unknown): void;
}

type TwoLegSubmitSuccess = {
    ok: true;
    primary: OrderExecution;
    secondary: OrderExecution;
};

type TwoLegSubmitFailure = {
    ok: false;
    primary?: OrderExecution;
    secondary?: OrderExecution;
    primaryError?: unknown;
    secondaryError?: unknown;
};

type TwoLegSubmitResult = TwoLegSubmitSuccess | TwoLegSubmitFailure;

export interface ExecutionEngineState {
    paused: boolean;
    riskLocked: boolean;
    activeTradeCount: number;
    symbols: Array<{
        symbol: string;
        status: string;
        activeTrade: string | null;
        lastError: string | null;
    }>;
}

export interface RuntimeTradePnlSnapshot {
    trade_id: number;
    local_trade_id: string;
    coin: string;
    order_type: 'buy' | 'sell';
    amount: number;
    opened_at: string;
    current_pnl_percent: number | null;
    estimated_pnl_usdt: number | null;
    estimated_pnl_percentage: number | null;
    pricing_mode: 'strict' | 'emergency' | 'unavailable';
}

export class ExecutionEngine {
    private readonly spreadEngine: SpreadEngine;
    private readonly pnlEngine: PnlEngine;
    private readonly tradeCounter: TradeCounter;
    private readonly states = new Map<string, SymbolSignalState>();
    private paused = false;
    private riskLocked = false;

    constructor(
        private readonly runtime: NormalizedRuntimeConfig,
        private readonly store: OrderBookStore,
        private readonly marketInfo: Map<string, UnifiedMarketInfo>,
        private readonly tradeClients: Map<ExchangeName, TradeWsClient>,
        private readonly tradeWriter: TradeWriterLike | AsyncTradeWriter,
        private readonly eventWriter: EventWriterLike | AsyncEventWriter,
        private readonly errorReporter: RuntimeErrorReporter,
        private readonly latencyMetrics: LatencyMetricsStore,
    ) {
        this.spreadEngine = new SpreadEngine(runtime);
        this.pnlEngine = new PnlEngine(runtime);
        this.tradeCounter = new TradeCounter(runtime.maxConcurrentTrades);
        for (const symbol of marketInfo.keys()) {
            this.states.set(symbol, createSymbolSignalState(symbol));
        }
    }

    pause(): void {
        this.paused = true;
        for (const state of this.states.values()) {
            if (state.status === 'idle') {
                state.status = 'paused';
            }
        }
    }

    resume(): void {
        this.paused = false;
        for (const state of this.states.values()) {
            if (state.status === 'paused') {
                state.status = 'idle';
            }
        }
    }

    lockRisk(reason: string): void {
        this.riskLocked = true;
        void this.errorReporter.report('runtime', reason);
    }

    isReadyForTrading(): boolean {
        if (this.paused || this.riskLocked) {
            return false;
        }
        const primary = this.tradeClients.get(this.runtime.primaryExchange);
        const secondary = this.tradeClients.get(this.runtime.secondaryExchange);
        return Boolean(primary?.isReady() && secondary?.isReady());
    }

    async onMarketUpdate(symbol: string): Promise<void> {
        const state = this.states.get(symbol);
        if (!state) {
            return;
        }

        if (isBusyStatus(state.status)) {
            state.pendingRerun = true;
            return;
        }

        do {
            state.pendingRerun = false;
            await this.evaluateSymbol(state);
        } while (state.pendingRerun && !isBusyStatus(state.status));
    }

    getState(): ExecutionEngineState {
        return {
            paused: this.paused,
            riskLocked: this.riskLocked,
            activeTradeCount: this.tradeCounter.value(),
            symbols: [...this.states.values()].map(state => ({
                symbol: state.symbol,
                status: state.status,
                activeTrade: state.activeTrade?.localTradeId ?? null,
                lastError: state.lastError,
            })),
        };
    }

    getActiveTradeSnapshots(): RuntimeTradePnlSnapshot[] {
        return [...this.states.values()]
            .filter(state => state.activeTrade !== null)
            .map(state => this.buildActiveTradeSnapshot(state));
    }

    private async evaluateSymbol(state: SymbolSignalState): Promise<void> {
        const pair = this.readFreshPair(state.symbol);
        const now = Date.now();
        if (state.activeTrade && state.status === 'open') {
            const prices = pair
                ? this.calculatePrices(pair.primary, pair.secondary, state.activeTrade.quantity)
                : null;
            const closeSignal = this.pnlEngine.evaluateClose(state.activeTrade, prices, now);
            if (closeSignal) {
                await this.executeClose(
                    state,
                    prices ?? emergencyClosePrices(state.activeTrade),
                    closeSignal.currentPnlPercent,
                    closeSignal.reason,
                );
            }
            return;
        }

        if (!pair) {
            return;
        }

        const market = this.marketInfo.get(state.symbol);
        if (!market) {
            return;
        }

        const quantity = this.calculateQuantity(pair.primary, market);
        if (quantity <= 0) {
            return;
        }

        const prices = this.calculatePrices(pair.primary, pair.secondary, quantity);
        if (!prices) {
            return;
        }

        if (state.status !== 'idle' || !this.isReadyForTrading()) {
            return;
        }

        const evaluation = this.spreadEngine.evaluate(prices, market, state.baselineBuy, state.baselineSell);
        state.baselineBuy = evaluation.nextBaselineBuy;
        state.baselineSell = evaluation.nextBaselineSell;
        if (!evaluation.signal) {
            return;
        }

        const metrics: TradeLatencyMetrics = {
            localTradeId: createLocalTradeId(),
            symbol: state.symbol,
            direction: evaluation.signal.direction,
            market_update_received_at: Math.max(pair.primary.localTimestamp, pair.secondary.localTimestamp),
            signal_checked_at: now,
            signal_detected_at: Date.now(),
        };
        await this.executeOpen(state, prices, quantity, evaluation.signal.spread, metrics);
    }

    private async executeOpen(
        state: SymbolSignalState,
        prices: OrderbookPrices,
        quantity: number,
        openSpread: number,
        metrics: TradeLatencyMetrics,
    ): Promise<void> {
        if (!this.tradeCounter.tryReserve()) {
            return;
        }

        state.status = 'opening';
        metrics.orders_submit_started_at = Date.now();
        const intents = createOpenIntents({
            localTradeId: metrics.localTradeId,
            primaryExchange: this.runtime.primaryExchange,
            secondaryExchange: this.runtime.secondaryExchange,
            symbol: state.symbol,
            direction: metrics.direction,
            quantity,
        });

        const submitted = await this.submitTwoLegs(intents, metrics);
        if (!submitted.ok) {
            const rollback = await this.rollbackPartialOpen(intents, submitted);
            this.tradeCounter.release();
            state.status = 'error_exposure';
            state.lastError = rollback.attempted
                ? `Open order submit failed; rollback ${rollback.succeeded ? 'succeeded' : 'failed'}.`
                : 'Open order submit failed.';
            this.eventWriter.enqueue({
                type: 'open_failed',
                symbol: state.symbol,
                localTradeId: metrics.localTradeId,
                primaryOrder: submitted.primary ?? null,
                secondaryOrder: submitted.secondary ?? null,
                rollback,
                metrics,
            });
            this.lockRisk(`Open order submit failed for ${state.symbol}; rollback ${rollback.succeeded ? 'succeeded' : 'failed or was not possible'}; manual reconciliation is required.`);
            return;
        }

        const primaryFallback = metrics.direction === 'buy' ? prices.primaryAsk : prices.primaryBid;
        const secondaryFallback = metrics.direction === 'buy' ? prices.secondaryBid : prices.secondaryAsk;
        const actualOpenedAtMs = twoLegCompletionMs(submitted.primary, submitted.secondary);
        metrics.actual_opened_at = actualOpenedAtMs;
        metrics.signal_to_actual_open_ms = actualOpenedAtMs - (metrics.signal_detected_at ?? actualOpenedAtMs);
        const activeTrade: ActiveTrade = {
            localTradeId: metrics.localTradeId,
            djangoTradeId: null,
            runtimeConfigId: this.runtime.runtimeConfigId,
            symbol: state.symbol,
            direction: metrics.direction,
            quantity,
            primaryExchange: this.runtime.primaryExchange,
            secondaryExchange: this.runtime.secondaryExchange,
            primaryOpenPrice: executionPriceOrFallback(submitted.primary, primaryFallback),
            secondaryOpenPrice: executionPriceOrFallback(submitted.secondary, secondaryFallback),
            primaryOpenOrderId: submitted.primary.orderId,
            secondaryOpenOrderId: submitted.secondary.orderId,
            openSpread,
            openCommission: submitted.primary.commission + submitted.secondary.commission,
            openedAt: new Date(actualOpenedAtMs).toISOString(),
            openExecutions: submitted,
        };

        state.activeTrade = activeTrade;
        state.status = 'open';
        this.latencyMetrics.add(metrics);
        this.eventWriter.enqueue({ type: 'open_submitted', activeTrade, metrics });
        this.eventWriter.enqueue(createOpenTimingEvent(activeTrade, metrics));
        this.tradeWriter.enqueueOpen(activeTrade);
    }

    private async executeClose(
        state: SymbolSignalState,
        prices: OrderbookPrices,
        currentPnlPercent: number,
        closeReason: ClosedTrade['closeReason'],
    ): Promise<void> {
        const activeTrade = state.activeTrade;
        if (!activeTrade) {
            return;
        }

        state.status = 'closing';
        const metrics: TradeLatencyMetrics = {
            localTradeId: `${activeTrade.localTradeId}-close`,
            symbol: state.symbol,
            direction: activeTrade.direction,
            market_update_received_at: Date.now(),
            signal_checked_at: Date.now(),
            signal_detected_at: Date.now(),
            orders_submit_started_at: Date.now(),
        };
        const intents = createCloseIntents({
            localTradeId: activeTrade.localTradeId,
            primaryExchange: this.runtime.primaryExchange,
            secondaryExchange: this.runtime.secondaryExchange,
            symbol: state.symbol,
            direction: activeTrade.direction,
            quantity: activeTrade.quantity,
        });

        const submitted = await this.submitTwoLegs(intents, metrics);
        if (!submitted.ok) {
            state.status = 'error_exposure';
            state.lastError = 'Close order submit failed.';
            this.eventWriter.enqueue({
                type: 'close_failed',
                symbol: state.symbol,
                localTradeId: activeTrade.localTradeId,
                primaryOrder: submitted.primary ?? null,
                secondaryOrder: submitted.secondary ?? null,
                metrics,
            });
            this.lockRisk(`Close order submit failed for ${state.symbol}; manual reconciliation is required.`);
            return;
        }

        const primaryFallback = activeTrade.direction === 'buy' ? prices.primaryBid : prices.primaryAsk;
        const secondaryFallback = activeTrade.direction === 'buy' ? prices.secondaryAsk : prices.secondaryBid;
        const primaryClosePrice = executionPriceOrFallback(submitted.primary, primaryFallback);
        const secondaryClosePrice = executionPriceOrFallback(submitted.secondary, secondaryFallback);
        const actualClosedAtMs = twoLegCompletionMs(submitted.primary, submitted.secondary);
        metrics.actual_closed_at = actualClosedAtMs;
        metrics.signal_to_actual_close_ms = actualClosedAtMs - (metrics.signal_detected_at ?? actualClosedAtMs);
        const closeCommission = submitted.primary.commission + submitted.secondary.commission;
        const finalPnl = this.pnlEngine.calculateFinalPnl(activeTrade, {
            primaryPrice: primaryClosePrice,
            secondaryPrice: secondaryClosePrice,
            commission: closeCommission,
        });

        const closedTrade: ClosedTrade = {
            activeTrade,
            primaryCloseExecution: submitted.primary,
            secondaryCloseExecution: submitted.secondary,
            primaryClosePrice,
            secondaryClosePrice,
            closeSpread: calculateOpenSpread(prices, activeTrade.direction),
            closeCommission,
            profitUsdt: finalPnl.profitUsdt,
            profitPercentage: finalPnl.profitPercentage,
            closeReason,
            closedAt: new Date(actualClosedAtMs).toISOString(),
        };

        state.activeTrade = null;
        state.status = 'close_pending_persistence';
        this.tradeCounter.release();
        this.latencyMetrics.add(metrics);
        this.eventWriter.enqueue({ type: 'close_submitted', closedTrade, currentPnlPercent, metrics });
        this.eventWriter.enqueue(createCloseTimingEvent(closedTrade, metrics));
        this.tradeWriter.enqueueClose(closedTrade, () => {
            if (state.status === 'close_pending_persistence' && !state.activeTrade) {
                state.status = this.paused ? 'paused' : 'idle';
            }
        });
    }

    private async submitTwoLegs(
        intents: ReturnType<typeof createOpenIntents>,
        metrics: TradeLatencyMetrics,
    ): Promise<TwoLegSubmitResult> {
        const primaryClient = this.tradeClients.get(intents.primary.exchange);
        const secondaryClient = this.tradeClients.get(intents.secondary.exchange);
        if (!primaryClient || !secondaryClient) {
            throw new Error('Trade clients are not configured.');
        }

        const primaryPromise = (async () => {
            this.setSendMetric(intents.primary.exchange, metrics);
            return primaryClient.submitMarketOrder(intents.primary);
        })();
        const secondaryPromise = (async () => {
            this.setSendMetric(intents.secondary.exchange, metrics);
            return secondaryClient.submitMarketOrder(intents.secondary);
        })();

        const [primaryResult, secondaryResult] = await Promise.allSettled([primaryPromise, secondaryPromise]);
        if (primaryResult.status !== 'fulfilled' || secondaryResult.status !== 'fulfilled') {
            logger.error('ExecutionEngine', 'Two-leg submit failed', {
                primary: primaryResult.status === 'rejected' ? primaryResult.reason : 'ok',
                secondary: secondaryResult.status === 'rejected' ? secondaryResult.reason : 'ok',
            });
            if (primaryResult.status === 'fulfilled') {
                this.setAckMetric(primaryResult.value.exchange, metrics, primaryResult.value);
            }
            if (secondaryResult.status === 'fulfilled') {
                this.setAckMetric(secondaryResult.value.exchange, metrics, secondaryResult.value);
            }
            return {
                ok: false,
                primary: primaryResult.status === 'fulfilled' ? primaryResult.value : undefined,
                secondary: secondaryResult.status === 'fulfilled' ? secondaryResult.value : undefined,
                primaryError: primaryResult.status === 'rejected' ? primaryResult.reason : undefined,
                secondaryError: secondaryResult.status === 'rejected' ? secondaryResult.reason : undefined,
            };
        }

        this.setAckMetric(primaryResult.value.exchange, metrics, primaryResult.value);
        this.setAckMetric(secondaryResult.value.exchange, metrics, secondaryResult.value);
        return { ok: true, primary: primaryResult.value, secondary: secondaryResult.value };
    }

    private async rollbackPartialOpen(
        intents: ReturnType<typeof createOpenIntents>,
        result: TwoLegSubmitFailure,
    ): Promise<{ attempted: boolean; succeeded: boolean; executions: OrderExecution[]; errors: string[] }> {
        const rollbackIntents: OrderIntent[] = [];
        if (result.primary) {
            rollbackIntents.push(createRollbackIntent(intents.primary, result.primary));
        }
        if (result.secondary) {
            rollbackIntents.push(createRollbackIntent(intents.secondary, result.secondary));
        }

        if (rollbackIntents.length === 0) {
            return { attempted: false, succeeded: false, executions: [], errors: [] };
        }

        const executions: OrderExecution[] = [];
        const errors: string[] = [];
        for (const intent of rollbackIntents) {
            const client = this.tradeClients.get(intent.exchange);
            if (!client) {
                errors.push(`${intent.exchange}: trade client is not configured`);
                continue;
            }
            try {
                executions.push(await client.submitMarketOrder(intent));
            } catch (error) {
                errors.push(`${intent.exchange}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const succeeded = executions.length === rollbackIntents.length;
        this.eventWriter.enqueue({
            type: 'open_rollback_submitted',
            attempted: true,
            succeeded,
            executions,
            errors,
        });
        return { attempted: true, succeeded, executions, errors };
    }

    private setSendMetric(exchange: ExchangeName, metrics: TradeLatencyMetrics): void {
        const now = Date.now();
        if (exchange === 'binance') {
            metrics.binance_ws_send_at = now;
        } else {
            metrics.bybit_ws_send_at = now;
        }
    }

    private setAckMetric(exchange: ExchangeName, metrics: TradeLatencyMetrics, execution: OrderExecution): void {
        if (exchange === 'binance') {
            metrics.binance_ack_at = execution.acknowledgedAt;
            metrics.binance_fill_seen_at = execution.filledAt ?? undefined;
        } else {
            metrics.bybit_ack_at = execution.acknowledgedAt;
            metrics.bybit_fill_seen_at = execution.filledAt ?? undefined;
        }
    }

    private readFreshPair(symbol: string): { primary: OrderBookSnapshot; secondary: OrderBookSnapshot } | null {
        const pair = this.store.getPair(this.runtime.primaryExchange, this.runtime.secondaryExchange, symbol);
        if (!pair) {
            return null;
        }

        const now = Date.now();
        const primaryAge = now - pair.primary.localTimestamp;
        const secondaryAge = now - pair.secondary.localTimestamp;
        const skew = Math.abs(pair.primary.localTimestamp - pair.secondary.localTimestamp);
        if (primaryAge > this.runtime.orderbookMaxAgeMs || secondaryAge > this.runtime.orderbookMaxAgeMs) {
            return null;
        }
        if (skew > this.runtime.orderbookMaxSkewMs) {
            return null;
        }
        return pair;
    }

    private calculateQuantity(primary: OrderBookSnapshot, marketInfo: UnifiedMarketInfo): number {
        const topPrice = primary.asks[0]?.[0] ?? primary.bids[0]?.[0] ?? 0;
        if (topPrice <= 0) {
            return 0;
        }
        const rawQty = this.runtime.tradeAmountUsdt / topPrice;
        const quantity = roundDownToStep(rawQty, marketInfo.stepSize);
        if (quantity < marketInfo.minQty || quantity * topPrice < marketInfo.minNotional) {
            return 0;
        }
        return quantity;
    }

    private calculatePrices(primary: OrderBookSnapshot, secondary: OrderBookSnapshot, quantity: number): OrderbookPrices | null {
        const prices = {
            primaryBid: calculateVWAP(primary.bids, quantity),
            primaryAsk: calculateVWAP(primary.asks, quantity),
            secondaryBid: calculateVWAP(secondary.bids, quantity),
            secondaryAsk: calculateVWAP(secondary.asks, quantity),
        };

        return Object.values(prices).every(Number.isFinite) ? prices : null;
    }

    private buildActiveTradeSnapshot(state: SymbolSignalState): RuntimeTradePnlSnapshot {
        const activeTrade = state.activeTrade;
        if (!activeTrade) {
            throw new Error(`No active trade for ${state.symbol}.`);
        }

        const base = {
            trade_id: activeTrade.djangoTradeId ?? numericTradeId(activeTrade.localTradeId),
            local_trade_id: activeTrade.localTradeId,
            coin: activeTrade.symbol,
            order_type: activeTrade.direction,
            amount: activeTrade.quantity,
            opened_at: activeTrade.openedAt,
        };
        const pair = this.readFreshPair(state.symbol);
        if (!pair) {
            return {
                ...base,
                current_pnl_percent: null,
                estimated_pnl_usdt: null,
                estimated_pnl_percentage: null,
                pricing_mode: 'unavailable',
            };
        }

        const prices = this.calculatePrices(pair.primary, pair.secondary, activeTrade.quantity);
        if (!prices) {
            return {
                ...base,
                current_pnl_percent: null,
                estimated_pnl_usdt: null,
                estimated_pnl_percentage: null,
                pricing_mode: 'unavailable',
            };
        }

        const primaryPrice = activeTrade.direction === 'buy' ? prices.primaryBid : prices.primaryAsk;
        const secondaryPrice = activeTrade.direction === 'buy' ? prices.secondaryAsk : prices.secondaryBid;
        const estimated = this.pnlEngine.calculateFinalPnl(activeTrade, {
            primaryPrice,
            secondaryPrice,
            commission: 0,
        });

        return {
            ...base,
            current_pnl_percent: estimated.profitPercentage,
            estimated_pnl_usdt: estimated.profitUsdt,
            estimated_pnl_percentage: estimated.profitPercentage,
            pricing_mode: 'strict',
        };
    }
}

function createLocalTradeId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function numericTradeId(localTradeId: string): number {
    let hash = 0;
    for (const char of localTradeId) {
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    }
    return hash;
}

function isBusyStatus(status: string): boolean {
    return status === 'opening' || status === 'closing';
}

function twoLegCompletionMs(primary: OrderExecution, secondary: OrderExecution): number {
    return Math.max(completionMs(primary), completionMs(secondary));
}

function completionMs(execution: OrderExecution): number {
    return execution.filledAt ?? execution.acknowledgedAt;
}

function createRollbackIntent(openIntent: OrderIntent, execution: OrderExecution): OrderIntent {
    return {
        intentId: `${openIntent.intentId}:rollback`,
        clientOrderId: `${openIntent.clientOrderId.slice(0, 28)}rb`,
        exchange: openIntent.exchange,
        symbol: openIntent.symbol,
        side: openIntent.side === 'buy' ? 'sell' : 'buy',
        quantity: execution.filledQty > 0 ? execution.filledQty : execution.quantity,
        reduceOnly: true,
        createdAt: Date.now(),
    };
}

function emergencyClosePrices(activeTrade: ActiveTrade): OrderbookPrices {
    return {
        primaryBid: activeTrade.primaryOpenPrice,
        primaryAsk: activeTrade.primaryOpenPrice,
        secondaryBid: activeTrade.secondaryOpenPrice,
        secondaryAsk: activeTrade.secondaryOpenPrice,
    };
}

function createOpenTimingEvent(activeTrade: ActiveTrade, metrics: TradeLatencyMetrics): Record<string, unknown> {
    const signalDetectedAt = metrics.signal_detected_at;
    const actualOpenedAt = metrics.actual_opened_at;
    return {
        type: 'trade_timing',
        phase: 'open',
        localTradeId: activeTrade.localTradeId,
        runtimeConfigId: activeTrade.runtimeConfigId,
        symbol: activeTrade.symbol,
        direction: activeTrade.direction,
        signal_detected_at: signalDetectedAt ?? null,
        signal_detected_iso: signalDetectedAt ? new Date(signalDetectedAt).toISOString() : null,
        actual_opened_at: actualOpenedAt ?? null,
        actual_opened_iso: actualOpenedAt ? new Date(actualOpenedAt).toISOString() : null,
        detection_to_actual_open_ms: metrics.signal_to_actual_open_ms ?? null,
        binance_ack_at: metrics.binance_ack_at ?? null,
        bybit_ack_at: metrics.bybit_ack_at ?? null,
        binance_fill_seen_at: metrics.binance_fill_seen_at ?? null,
        bybit_fill_seen_at: metrics.bybit_fill_seen_at ?? null,
    };
}

function createCloseTimingEvent(closedTrade: ClosedTrade, metrics: TradeLatencyMetrics): Record<string, unknown> {
    const signalDetectedAt = metrics.signal_detected_at;
    const actualClosedAt = metrics.actual_closed_at;
    return {
        type: 'trade_timing',
        phase: 'close',
        localTradeId: closedTrade.activeTrade.localTradeId,
        runtimeConfigId: closedTrade.activeTrade.runtimeConfigId,
        symbol: closedTrade.activeTrade.symbol,
        direction: closedTrade.activeTrade.direction,
        close_reason: closedTrade.closeReason,
        close_signal_detected_at: signalDetectedAt ?? null,
        close_signal_detected_iso: signalDetectedAt ? new Date(signalDetectedAt).toISOString() : null,
        actual_closed_at: actualClosedAt ?? null,
        actual_closed_iso: actualClosedAt ? new Date(actualClosedAt).toISOString() : null,
        signal_to_actual_close_ms: metrics.signal_to_actual_close_ms ?? null,
        binance_ack_at: metrics.binance_ack_at ?? null,
        bybit_ack_at: metrics.bybit_ack_at ?? null,
        binance_fill_seen_at: metrics.binance_fill_seen_at ?? null,
        bybit_fill_seen_at: metrics.bybit_fill_seen_at ?? null,
    };
}

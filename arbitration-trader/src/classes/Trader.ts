import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, calculateRealPnLByLegSizes, d, checkLegDrawdown, calculateVWAP, roundDownToStep } from '../utils/math.js';
import { api } from '../services/api.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { CloseSyncService } from '../services/close-sync-service.js';
import { executionJournal } from '../services/execution-journal.js';
import { fetchConfirmedPosition } from '../services/position-recovery.js';
import { shadowRecorder } from '../services/shadow-recorder.js';
import { SignalEngine } from '../services/signal-engine.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { RuntimeRiskLock } from './risk-lock.js';
import type { TradeCounter } from './TradeCounter.js';
import { createPairState, type CloseTriggerReason, type PairState } from './trade-state.js';
import type {
    OrderBookProvider,
    OrderBookSnapshot,
    OrderbookPrices,
    RuntimeTradePnlSnapshot,
    TradeClosePayload,
    TradeRecord,
} from '../types/index.js';

const COOLDOWN_MS = 30_000; // 30s cooldown after failed order
const TIMEOUT_CHECK_INTERVAL_MS = 10_000; // Check timeouts every 10s
const UNMANAGED_CLEANUP_RETRY_MS = 10_000;
const RECONCILIATION_INTERVAL_MS = 60_000;

interface SignalCheckContext {
    marketEventAtMs: number | null;
    checkStartedAtMs: number;
}

interface SignalExecutionContext extends SignalCheckContext {
    signalDetectedAtMs: number;
}

type LatencyMetrics = Record<string, number | string | boolean | null>;

/**
 * Watches a chunk of symbols and executes arbitrage trades for that chunk.
 *
 * Multiple Trader instances share the same exchange websocket clients, REST
 * clients, market-info cache and TradeCounter. Each Trader owns independent
 * PairState objects for its assigned symbols.
 */
export class Trader {
    private tag: string;
    private isRunning = true;
    private states: Map<string, PairState> = new Map();
    private timeoutTimer: ReturnType<typeof setInterval> | null = null;
    private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
    private unsubscribeCallbacks: Array<() => void> = [];
    private scheduledChecks = new Set<string>();
    private runningChecks = new Set<string>();
    private rerunRequested = new Set<string>();
    private latestMarketEventAt = new Map<string, number>();
    private stopResolve: (() => void) | null = null;
    private isStopping = false;
    private readonly signalEngine = new SignalEngine();
    private readonly closeSync: CloseSyncService;

    constructor(
        public id: number,
        public symbols: string[],
        private primaryBooks: OrderBookProvider,
        private secondaryBooks: OrderBookProvider,
        private primaryClient: IExchangeClient,
        private secondaryClient: IExchangeClient,
        private marketInfo: MarketInfoService,
        private tradeCounter: TradeCounter,
        private riskLock: RuntimeRiskLock,
        private entryDisabledSymbols: Set<string> = new Set(),
    ) {
        this.tag = `Trader-${id}`;
        this.closeSync = new CloseSyncService(this.tag);
        // Pre-create state for every symbol so runtime checks can use direct
        // Map lookups without creating state while websocket callbacks are active.
        for (const sym of symbols) {
            this.states.set(sym, createPairState(!this.entryDisabledSymbols.has(sym)));
        }
    }

    /**
     * Restore open trades from Django API after a restart.
     */
    public restoreOpenTrades(openTrades: TradeRecord[]): void {
        for (const trade of openTrades) {
            const sym = trade.coin;
            const state = this.states.get(sym);
            if (!state) {
                continue;
            }

            if (state.activeTrade) {
                throw new Error(`Duplicate restored open trade for ${sym}: ${state.activeTrade.id} and ${trade.id}.`);
            }

            const openedAtMs = new Date(trade.opened_at).getTime();
            if (!Number.isFinite(openedAtMs) || openedAtMs <= 0) {
                throw new Error(`Open trade ${trade.id} for ${sym} has invalid opened_at: ${trade.opened_at}`);
            }

            // Reserve a global slot because restored trades already occupy
            // real exchange exposure and must count toward concurrency.
            state.activeTrade = trade;
            state.openedAtMs = openedAtMs;
            this.tradeCounter.forceReserve();
            logger.info(this.tag, `♻️ Restored open trade ${sym} (ID: ${trade.id}, ${trade.order_type})`);
        }
    }

    public getActiveTradeSnapshots(): RuntimeTradePnlSnapshot[] {
        const snapshots: RuntimeTradePnlSnapshot[] = [];

        for (const [symbol, state] of this.states.entries()) {
            const trade = state.activeTrade;
            if (!trade) {
                continue;
            }

            const amount = parseFloat(trade.amount as any);
            const strictPrices = this.getPrices(symbol, amount, false);
            const emergencyPrices = strictPrices ? null : this.getPrices(symbol, amount, true);
            const prices = strictPrices || emergencyPrices;
            const pricingMode = strictPrices ? 'strict' : emergencyPrices ? 'emergency' : 'unavailable';

            let currentPnlPercent: number | null = null;
            let estimatedPnlUsdt: number | null = null;
            let estimatedPnlPercentage: number | null = null;

            if (prices) {
                const orderType = trade.order_type as 'buy' | 'sell';
                const pOpen = parseFloat(trade.primary_open_price as any);
                const sOpen = parseFloat(trade.secondary_open_price as any);
                const openCommission = parseFloat(trade.open_commission as any) || 0;
                const closePrimary = orderType === 'buy' ? prices.primaryBid : prices.primaryAsk;
                const closeSecondary = orderType === 'buy' ? prices.secondaryAsk : prices.secondaryBid;
                const estimated = calculateRealPnL(
                    pOpen,
                    sOpen,
                    closePrimary,
                    closeSecondary,
                    amount,
                    orderType,
                    openCommission,
                );

                currentPnlPercent = d(
                    calculateTruePnL({ pOpen, sOpen }, prices, orderType),
                    4,
                );
                estimatedPnlUsdt = d(estimated.profitUsdt, 6);
                estimatedPnlPercentage = d(estimated.profitPercentage, 4);
            }

            snapshots.push({
                trade_id: trade.id,
                coin: trade.coin,
                order_type: trade.order_type as 'buy' | 'sell',
                amount,
                opened_at: trade.opened_at,
                current_pnl_percent: currentPnlPercent,
                estimated_pnl_usdt: estimatedPnlUsdt,
                estimated_pnl_percentage: estimatedPnlPercentage,
                pricing_mode: pricingMode,
            });
        }

        return snapshots;
    }

    /**
     * Start processing provider updates. Returns a Promise that never resolves
     * (keeps running until `stop()` is called).
     */
    public async start(): Promise<void> {
        logger.info(this.tag, `Starting loops for ${this.symbols.length} pairs...`);
        this.isRunning = true;
        this.isStopping = false;

        // Start the timeout watchdog separately from websocket ticks so positions
        // can be closed even when a symbol stops receiving frequent book updates.
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);
        this.reconciliationTimer = setInterval(() => {
            void this.reconcileTrackedPositions();
        }, RECONCILIATION_INTERVAL_MS);

        const handleUpdate = (symbol: string) => {
            if (this.states.has(symbol)) {
                this.scheduleCheck(symbol, Date.now());
            }
        };
        this.unsubscribeCallbacks = [
            this.primaryBooks.onUpdate(handleUpdate),
            this.secondaryBooks.onUpdate(handleUpdate),
        ];

        for (const symbol of this.symbols) {
            this.scheduleCheck(symbol);
        }

        await new Promise<void>(resolve => {
            this.stopResolve = resolve;
        });
    }

    /**
     * Stop the trader. If closePositions is true, close all active positions on exchanges.
     */
    public async stop(closePositions: boolean = false): Promise<void> {
        if (closePositions) {
            // Stop accepting entries first, but keep timers and subscriptions
            // alive until all exposure is confirmed flat or synced.
            this.isStopping = true;
            await this.closeAllPositions('shutdown');
            if (this.riskLock.isLocked) {
                throw new Error('Runtime risk lock is active; trader remains online for reconciliation.');
            }
        }

        this.finishStop();
    }

    public hasOpenExposure(): boolean {
        return this.getExposureSummary().length > 0;
    }

    public getExposureSummary(): string[] {
        const result: string[] = [];

        for (const [symbol, state] of this.states.entries()) {
            if (state.activeTrade) {
                result.push(`${symbol}:active_trade`);
            }
            if (state.pendingCloseSync) {
                result.push(`${symbol}:pending_close_sync`);
            }
            if (state.unmanagedExposure) {
                result.push(`${symbol}:unmanaged_exposure`);
            }
        }

        return result;
    }

    private finishStop(): void {
        this.isRunning = false;

        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer);
            this.reconciliationTimer = null;
        }

        for (const unsubscribe of this.unsubscribeCallbacks) {
            unsubscribe();
        }
        this.unsubscribeCallbacks = [];

        this.stopResolve?.();
        this.stopResolve = null;
        logger.info(this.tag, 'Stopped.');
    }

    private scheduleCheck(symbol: string, marketEventAtMs: number | null = null): void {
        if (marketEventAtMs !== null) {
            this.latestMarketEventAt.set(symbol, marketEventAtMs);
        }

        if (!this.isRunning) {
            return;
        }

        if (this.runningChecks.has(symbol)) {
            this.rerunRequested.add(symbol);
            return;
        }

        if (this.scheduledChecks.has(symbol)) {
            return;
        }

        this.scheduledChecks.add(symbol);
        queueMicrotask(() => {
            this.scheduledChecks.delete(symbol);
            if (!this.isRunning || this.runningChecks.has(symbol)) {
                return;
            }

            this.runningChecks.add(symbol);
            const checkStartedAtMs = Date.now();
            const context: SignalCheckContext = {
                marketEventAtMs: this.latestMarketEventAt.get(symbol) ?? null,
                checkStartedAtMs,
            };

            void this.checkSpreads(symbol, context)
                .catch((error: any) => {
                    logger.error(this.tag, `Spread check failed for ${symbol}: ${error.message}`);
                })
                .finally(() => {
                    this.runningChecks.delete(symbol);
                    this.scheduleDeferredCheckIfNeeded(symbol);
                });
        });
    }

    private scheduleDeferredCheckIfNeeded(symbol: string): void {
        const state = this.states.get(symbol);
        if (!state || state.busy || !this.rerunRequested.delete(symbol)) {
            return;
        }

        this.scheduleCheck(symbol);
    }

    private getPrices(symbol: string, targetCoinsFallback?: number, isEmergency: boolean = false): OrderbookPrices | null {
        const bOb = this.primaryBooks.getOrderBook(symbol);
        const yOb = this.secondaryBooks.getOrderBook(symbol);

        if (
            !bOb?.bids?.length || !bOb?.asks?.length ||
            !yOb?.bids?.length || !yOb?.asks?.length
        ) {
            return null;
        }

        if (!this.isFreshOrderBookPair(symbol, bOb, yOb)) {
            return null;
        }

        const info = this.marketInfo.getInfo(symbol);
        // Entry uses the precomputed static trade amount; close uses the exact
        // recorded trade amount passed as targetCoinsFallback.
        const targetCoins = targetCoinsFallback ?? info?.tradeAmount ?? 0;

        // Use VWAP rather than best bid/ask so signal calculations include depth
        // needed to fill the configured trade amount.
        const pBid = calculateVWAP(bOb.bids, targetCoins, isEmergency);
        const pAsk = calculateVWAP(bOb.asks, targetCoins, isEmergency);
        const sBid = calculateVWAP(yOb.bids, targetCoins, isEmergency);
        const sAsk = calculateVWAP(yOb.asks, targetCoins, isEmergency);

        if (isNaN(pBid) || isNaN(pAsk) || isNaN(sBid) || isNaN(sAsk)) {
            // Not enough visible liquidity to fill this target size.
            logger.debug(this.tag, `📉 Insufficient depth on ${symbol} to fill ${targetCoins} coins. isEmergency: ${isEmergency}`);
            return null;
        }

        return {
            primaryBid: pBid,
            primaryAsk: pAsk,
            secondaryBid: sBid,
            secondaryAsk: sAsk,
        };
    }

    private isFreshOrderBookPair(
        symbol: string,
        primarySnapshot: OrderBookSnapshot,
        secondarySnapshot: OrderBookSnapshot,
    ): boolean {
        const now = Date.now();
        const primaryAgeMs = now - primarySnapshot.localTimestamp;
        const secondaryAgeMs = now - secondarySnapshot.localTimestamp;
        const skewMs = Math.abs(primarySnapshot.localTimestamp - secondarySnapshot.localTimestamp);

        if (
            primaryAgeMs > config.orderbookPairMaxAgeMs ||
            secondaryAgeMs > config.orderbookPairMaxAgeMs ||
            skewMs > config.orderbookPairMaxSkewMs
        ) {
            logger.debug(
                this.tag,
                `Skipping ${symbol}: stale/skewed orderbook pair `
                + `(primaryAgeMs=${primaryAgeMs}, secondaryAgeMs=${secondaryAgeMs}, skewMs=${skewMs})`,
            );
            return false;
        }

        return true;
    }

    // ───────────── Private: Spread Logic ─────────────

    private async checkSpreads(symbol: string, context: SignalCheckContext) {
        const state = this.states.get(symbol)!;
        // Both websocket loops can call checkSpreads for the same symbol. The
        // busy flag prevents duplicate open/close operations.
        if (state.busy) {
            this.rerunRequested.add(symbol);
            return;
        }

        if (state.unmanagedExposure) {
            await this.retryUnmanagedExposureCleanup(symbol, state);
            return;
        }

        if (state.pendingCloseSync) {
            await this.flushPendingClose(symbol, state);
            return;
        }

        const info = this.marketInfo.getInfo(symbol);
        if (!info) return;

        const isClosing = !!state.activeTrade;
        let targetCoins: number;

        if (isClosing) {
            // If in trade, use exact closing volume from Django.
            targetCoins = parseFloat(state.activeTrade!.amount as any);
        } else {
            // Dynamic lot sizing based on current primary best bid and configured
            // USDT budget.
            const bOb = this.primaryBooks.getOrderBook(symbol);
            const currentPrice = bOb?.bids?.[0]?.[0];
            if (!currentPrice) return;

            const rawAmount = config.tradeAmountUsdt / currentPrice;
            targetCoins = roundDownToStep(rawAmount, info.stepSize);

            if (targetCoins < info.minQty || (targetCoins * currentPrice) < info.minNotional) {
                // Not enough budget to meet exchange lot/notional requirements.
                return;
            }
        }
        
        if (isClosing) {
            // While a trade is active, do not evaluate entries. Monitor exit
            // conditions using strict prices for profit and emergency prices for
            // risk exits.
            const strictPrices = this.getPrices(symbol, targetCoins, false);
            const emergencyPrices = this.getPrices(symbol, targetCoins, true);
            await this.checkExit(symbol, state, strictPrices, emergencyPrices, context);
            return;
        }

        if (!state.canOpenNewTrades) {
            return;
        }

        if (this.isStopping || this.riskLock.isLocked) {
            return;
        }

        // Idle state: look for entry.
        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices) return;

        const evaluation = this.signalEngine.evaluateEntry(
            prices,
            info,
            state.baselineBuy,
            state.baselineSell,
        );
        state.baselineBuy = evaluation.nextBaselineBuy;
        state.baselineSell = evaluation.nextBaselineSell;

        // Check global concurrent limit first as a cheap read-only guard.
        if (!this.tradeCounter.canOpen()) return;

        // Cooldown prevents immediate re-entry after failed orders/cleanup.
        if (Date.now() < state.cooldownUntil) return;

        if (evaluation.decision) {
            const signalContext: SignalExecutionContext = {
                ...context,
                signalDetectedAtMs: Date.now(),
            };
            await this.executeOpen(
                symbol,
                state,
                evaluation.decision.orderType,
                prices,
                evaluation.decision.spread,
                targetCoins,
                evaluation.decision.expectedNetEdge,
                evaluation.decision.fundingCostPercent,
                signalContext,
            );
            return;
        }
    }

    // ───────────── Private: Open Trade ─────────────

    private async executeOpen(
        symbol: string,
        state: PairState,
        orderType: 'buy' | 'sell',
        prices: OrderbookPrices,
        spread: number,
        targetCoins: number,
        expectedNetEdge: number,
        fundingCostPercent: number,
        signalContext?: SignalExecutionContext,
    ) {
        state.busy = true;
        let slotReserved = false;
        let ordersMayHaveReachedExchange = false;
        const openIntentId = executionJournal.createIntentId('open', symbol);

        try {
            if (this.isStopping || this.riskLock.isLocked) {
                return;
            }

            if (config.shadowMode) {
                await shadowRecorder.recordEntrySignal({
                    symbol,
                    order_type: orderType,
                    amount: targetCoins,
                    spread: d(spread, 4),
                    expected_net_edge: d(expectedNetEdge, 4),
                    funding_cost_percent: d(fundingCostPercent, 4),
                    prices,
                });
                state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            // Reserve a global slot atomically. This closes a race where multiple
            // symbols pass canOpen() before any one of them opens.
            if (!this.tradeCounter.reserve()) {
                logger.debug(this.tag, `Skipping ${symbol}: concurrent trade limit reached just now`);
                return;
            }
            slotReserved = true;

            const amount = targetCoins;

            logger.info(this.tag, `🔴 OPENING ${symbol} (${orderType}), amount: ${amount}, spread: ${spread.toFixed(3)}%, expected net edge: ${expectedNetEdge.toFixed(3)}%`);

            await executionJournal.record(openIntentId, 'open', 'open_intent', symbol, {
                order_type: orderType,
                amount,
                spread: d(spread, 4),
                expected_net_edge: d(expectedNetEdge, 4),
                funding_cost_percent: d(fundingCostPercent, 4),
            });

            // Determine order sides for each exchange.
            const primarySide = orderType === 'buy' ? 'buy' : 'sell';
            const secondarySide = orderType === 'buy' ? 'sell' : 'buy';

            await this.assertNoUnexpectedPositions(symbol, state);

            // Execute both legs concurrently to reduce legging risk. allSettled
            // lets us inspect partial success and flatten any filled leg.
            ordersMayHaveReachedExchange = true;
            await executionJournal.record(openIntentId, 'open', 'open_orders_submitting', symbol, {
                primary_side: primarySide,
                secondary_side: secondarySide,
                amount,
            });
            const orderSubmitStartedAtMs = Date.now();
            const [pSettled, sSettled] = await Promise.allSettled([
                this.primaryClient.createMarketOrder(symbol, primarySide, amount),
                this.secondaryClient.createMarketOrder(symbol, secondarySide, amount),
            ]);
            const exchangeAckAtMs = Date.now();
            this.logLatencyMetrics('open_signal', symbol, {
                ...this.buildSignalLatencyMetrics(signalContext, orderSubmitStartedAtMs),
                order_submit_start_to_exchange_ack_ms: exchangeAckAtMs - orderSubmitStartedAtMs,
                primary_fulfilled: pSettled.status === 'fulfilled',
                secondary_fulfilled: sSettled.status === 'fulfilled',
            });

            if (pSettled.status === 'rejected' || sSettled.status === 'rejected') {
                logger.error(this.tag, `❌ Atomic execution failed for ${symbol}! Reverting successful legs...`);
                
                // Roll back the leg that actually opened.
                if (pSettled.status === 'fulfilled') {
                    await executionJournal.record(openIntentId, 'open', 'open_leg_filled', symbol, {
                        leg: 'primary',
                        order_id: pSettled.value.orderId,
                        filled_qty: pSettled.value.filledQty,
                        avg_price: pSettled.value.avgPrice,
                        commission: pSettled.value.commission,
                    });
                    const revSide = primarySide === 'buy' ? 'sell' : 'buy';
                    // reduceOnly is critical to avoid opening a new opposite
                    // margin position during rollback.
                    await this.primaryClient.createMarketOrder(symbol, revSide, pSettled.value.filledQty, { reduceOnly: true })
                        .catch((error: any) => logger.error(this.tag, `Primary rollback failed for ${symbol}: ${error.message}`));
                }
                if (sSettled.status === 'fulfilled') {
                    await executionJournal.record(openIntentId, 'open', 'open_leg_filled', symbol, {
                        leg: 'secondary',
                        order_id: sSettled.value.orderId,
                        filled_qty: sSettled.value.filledQty,
                        avg_price: sSettled.value.avgPrice,
                        commission: sSettled.value.commission,
                    });
                    const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
                    await this.secondaryClient.createMarketOrder(symbol, revSide, sSettled.value.filledQty, { reduceOnly: true })
                        .catch((error: any) => logger.error(this.tag, `Secondary rollback failed for ${symbol}: ${error.message}`));
                }

                // Insurance against network timeout: an order may have filled
                // even if the API call rejected before returning its response.
                await new Promise(r => setTimeout(r, 1000)); 
                const cleanupSucceeded = await this.safeHandleOpenCleanupWithRiskLock(symbol, state, orderType, slotReserved, openIntentId);

                if (cleanupSucceeded && slotReserved) {
                    this.tradeCounter.release();
                    slotReserved = false;
                } else if (!cleanupSucceeded) {
                    slotReserved = false;
                }
                state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            const primaryResult = pSettled.value;
            const secondaryResult = sSettled.value;

            await Promise.all([
                executionJournal.record(openIntentId, 'open', 'open_leg_filled', symbol, {
                    leg: 'primary',
                    order_id: primaryResult.orderId,
                    filled_qty: primaryResult.filledQty,
                    avg_price: primaryResult.avgPrice,
                    commission: primaryResult.commission,
                }),
                executionJournal.record(openIntentId, 'open', 'open_leg_filled', symbol, {
                    leg: 'secondary',
                    order_id: secondaryResult.orderId,
                    filled_qty: secondaryResult.filledQty,
                    avg_price: secondaryResult.avgPrice,
                    commission: secondaryResult.commission,
                }),
            ]);

            // Some exchange APIs initially return 0.00 average price for instant
            // market orders. Fall back to pre-order VWAP for persistence.
            const pPriceSafe = primaryResult.avgPrice > 0 ? primaryResult.avgPrice : (primarySide === 'buy' ? prices.primaryAsk : prices.primaryBid);
            const sPriceSafe = secondaryResult.avgPrice > 0 ? secondaryResult.avgPrice : (secondarySide === 'buy' ? prices.secondaryAsk : prices.secondaryBid);

            const totalCommission = d(primaryResult.commission + secondaryResult.commission, 6);

            // Recalculate spread from actual fill prices to include market order
            // slippage.
            let realOpenSpread = spread;
            if (pPriceSafe > 0 && sPriceSafe > 0) {
                realOpenSpread = orderType === 'buy'
                    ? ((sPriceSafe - pPriceSafe) / pPriceSafe) * 100
                    : ((pPriceSafe - sPriceSafe) / sPriceSafe) * 100;
            }

            // Record trade in Django with actual fill data. The local slot remains
            // reserved until executeClose releases it.
            const tradeRecord = await api.openTrade({
                runtime_config: config.runtimeConfigId,
                coin: symbol,
                primary_exchange: `${this.primaryClient.name.toLowerCase()}_futures`,
                secondary_exchange: `${this.secondaryClient.name.toLowerCase()}_futures`,
                order_type: orderType,
                status: 'open',
                amount: d(amount),
                leverage: config.leverage,
                primary_open_price: d(pPriceSafe),
                secondary_open_price: d(sPriceSafe),
                primary_open_order_id: primaryResult.orderId,
                secondary_open_order_id: secondaryResult.orderId,
                open_spread: d(realOpenSpread, 4),
                open_commission: totalCommission,
            });

            state.activeTrade = tradeRecord;
            state.openedAtMs = Date.now();
            slotReserved = false;

            await executionJournal.record(openIntentId, 'open', 'open_django_synced', symbol, {
                trade_id: tradeRecord.id,
            }).catch((journalError: any) => {
                state.canOpenNewTrades = false;
                this.riskLock.lock(
                    this.executionJournalRiskKey(symbol),
                    'execution_journal_failed',
                    journalError.message,
                );
                logger.error(this.tag, `Open trade ${tradeRecord.id} is in Django, but execution journal sync failed for ${symbol}: ${journalError.message}`);
            });

            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, ${this.primaryClient.name}: ${pPriceSafe}, ${this.secondaryClient.name}: ${sPriceSafe}`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open ${symbol}: ${e.message}`);

            // Atomic safety: if an order failed, or if Django API failed after
            // orders were placed, close any opened positions to avoid naked
            // exposure.
            if (ordersMayHaveReachedExchange) {
                const cleanupSucceeded = await this.safeHandleOpenCleanupWithRiskLock(symbol, state, orderType, slotReserved, openIntentId);
                if (!cleanupSucceeded) {
                    slotReserved = false;
                }
            } else {
                await executionJournal.record(openIntentId, 'open', 'open_aborted_before_orders', symbol, {
                    error: e.message,
                }).catch((journalError: any) => logger.error(this.tag, `Failed to append execution journal: ${journalError.message}`));
            }

            if (slotReserved) {
                this.tradeCounter.release();
                slotReserved = false;
            }
            state.baselineBuy = null;
            state.baselineSell = null;
            state.cooldownUntil = Date.now() + COOLDOWN_MS;
        } finally {
            state.busy = false;
            this.scheduleDeferredCheckIfNeeded(symbol);
        }
    }

    /**
     * Safety cleanup: if open fails for any reason (execution error, Django error),
     * check positions on both exchanges and close them to avoid naked exposure.
     */
    private async handleOpenCleanup(symbol: string, orderType: 'buy' | 'sell', intentId?: string) {
        logger.warn(this.tag, `⚠️ Cleanup triggered for ${symbol}. Checking for dangling positions...`);
        if (intentId) {
            await executionJournal.record(intentId, 'open', 'cleanup_started', symbol, { order_type: orderType });
        }

        // Query both exchanges rather than trusting local promise results. This
        // covers the case where an API request times out after the exchange filled.
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        const cleanupErrors: string[] = [];
        try {
            // Try closing any position that might have been opened on primary.
            try {
                const primaryPositions = await this.primaryClient.fetchPositions([symbol]);
                for (const pos of primaryPositions) {
                    if (pos.symbol !== symbol) continue;

                    const size = Math.abs(Number(pos.amount ?? pos.contracts ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        const result = await this.primaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        if (intentId) {
                            await executionJournal.record(intentId, 'open', 'open_leg_filled', symbol, {
                                leg: 'primary_cleanup',
                                order_id: result.orderId,
                                filled_qty: result.filledQty,
                                avg_price: result.avgPrice,
                                commission: result.commission,
                            });
                        }
                        logger.info(this.tag, `🧹 Cleaned up ${this.primaryClient.name} position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up ${this.primaryClient.name} position for ${symbol}: ${err.message}`);
                cleanupErrors.push(`${this.primaryClient.name}: ${err.message}`);
            }

            // Try closing any position that might have been opened on secondary.
            try {
                const secondaryPositions = await this.secondaryClient.fetchPositions([symbol]);
                for (const pos of secondaryPositions) {
                    if (pos.symbol !== symbol) continue;

                    const size = Math.abs(Number(pos.amount ?? pos.contracts ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        const result = await this.secondaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        if (intentId) {
                            await executionJournal.record(intentId, 'open', 'open_leg_filled', symbol, {
                                leg: 'secondary_cleanup',
                                order_id: result.orderId,
                                filled_qty: result.filledQty,
                                avg_price: result.avgPrice,
                                commission: result.commission,
                            });
                        }
                        logger.info(this.tag, `🧹 Cleaned up ${this.secondaryClient.name} position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up ${this.secondaryClient.name} position for ${symbol}: ${err.message}`);
                cleanupErrors.push(`${this.secondaryClient.name}: ${err.message}`);
            }

            if (cleanupErrors.length > 0) {
                throw new Error(cleanupErrors.join('; '));
            }

            if (intentId) {
                await executionJournal.record(intentId, 'open', 'cleanup_completed', symbol);
            }

        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ CRITICAL: Cleanup error for ${symbol}: ${cleanupErr.message}`);
            if (intentId) {
                await executionJournal.record(intentId, 'open', 'cleanup_failed', symbol, {
                    error: cleanupErr.message,
                }).catch((journalError: any) => logger.error(this.tag, `Failed to append execution journal: ${journalError.message}`));
            }
            throw cleanupErr;
        }
    }

    // ───────────── Private: Risk Lock / Cleanup ─────────────

    private async safeHandleOpenCleanupWithRiskLock(
        symbol: string,
        state: PairState,
        orderType: 'buy' | 'sell',
        slotReserved: boolean,
        intentId?: string,
    ): Promise<boolean> {
        try {
            await this.handleOpenCleanup(symbol, orderType, intentId);
            return true;
        } catch (error: any) {
            this.markUnmanagedExposure(symbol, state, orderType, slotReserved, error);
            logger.error(this.tag, `CRITICAL: Cleanup failed for ${symbol}. Runtime is risk-locked and cleanup will be retried: ${error.message}`);
            return false;
        }
    }

    private async assertNoUnexpectedPositions(symbol: string, state: PairState): Promise<void> {
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        const [primaryPositions, secondaryPositions] = await Promise.all([
            this.primaryClient.fetchPositions([symbol]),
            this.secondaryClient.fetchPositions([symbol]),
        ]);

        const unexpected = [
            ...primaryPositions.map(position => ({ exchange: this.primaryClient.name, position })),
            ...secondaryPositions.map(position => ({ exchange: this.secondaryClient.name, position })),
        ].filter(({ position }) => {
            const size = Math.abs(Number(position.amount ?? position.contracts ?? 0));
            return position.symbol === symbol && size > 0 && size >= minQty;
        });

        if (unexpected.length === 0) {
            this.riskLock.clear(this.manualExposureRiskKey(symbol));
            return;
        }

        state.canOpenNewTrades = false;
        const details = unexpected
            .map(({ exchange, position }) => {
                const size = Math.abs(Number(position.amount ?? position.contracts ?? 0));
                return `${exchange} ${position.side} ${size}`;
            })
            .join('; ');
        this.riskLock.lock(
            this.manualExposureRiskKey(symbol),
            'unexpected_position_before_entry',
            details,
        );
        throw new Error(`Unexpected existing position before entry on ${symbol}: ${details}`);
    }

    private markUnmanagedExposure(
        symbol: string,
        state: PairState,
        orderType: 'buy' | 'sell',
        slotReserved: boolean,
        error: Error,
    ): void {
        const now = Date.now();
        const previous = state.unmanagedExposure;
        state.canOpenNewTrades = false;
        state.unmanagedExposure = {
            orderType,
            slotReserved: previous?.slotReserved ?? slotReserved,
            cleanupAttempts: previous ? previous.cleanupAttempts + 1 : 1,
            lastError: error.message,
            lockedAtMs: previous?.lockedAtMs ?? now,
            nextRetryAtMs: now + UNMANAGED_CLEANUP_RETRY_MS,
        };
        this.riskLock.lock(
            this.unmanagedExposureRiskKey(symbol),
            'unmanaged_exposure_cleanup_failed',
            error.message,
        );
    }

    private async retryUnmanagedExposureCleanup(symbol: string, state: PairState, force: boolean = false): Promise<void> {
        const exposure = state.unmanagedExposure;
        if (!exposure || state.busy) {
            return;
        }

        if (!force && Date.now() < exposure.nextRetryAtMs) {
            return;
        }

        state.busy = true;
        try {
            logger.warn(this.tag, `Retrying unmanaged exposure cleanup for ${symbol}. Attempt ${exposure.cleanupAttempts + 1}.`);
            await this.handleOpenCleanup(symbol, exposure.orderType);
            if (exposure.slotReserved) {
                this.tradeCounter.release();
            }
            state.unmanagedExposure = null;
            state.cooldownUntil = Date.now() + COOLDOWN_MS;
            this.riskLock.clear(this.unmanagedExposureRiskKey(symbol));
            logger.info(this.tag, `Unmanaged exposure cleanup for ${symbol} completed and risk lock was cleared.`);
        } catch (error: any) {
            this.markUnmanagedExposure(symbol, state, exposure.orderType, exposure.slotReserved, error);
        } finally {
            state.busy = false;
            this.scheduleDeferredCheckIfNeeded(symbol);
        }
    }

    private unmanagedExposureRiskKey(symbol: string): string {
        return `${this.tag}:unmanaged:${symbol}`;
    }

    private manualExposureRiskKey(symbol: string): string {
        return `${this.tag}:manual-position:${symbol}`;
    }

    // ───────────── Private: Close Trade ─────────────

    private async checkExit(
        symbol: string,
        state: PairState,
        strictPrices: OrderbookPrices | null,
        emergencyPrices: OrderbookPrices | null,
        context: SignalCheckContext,
    ) {
        const trade = state.activeTrade!;
        const pOpen = parseFloat(trade.primary_open_price as any);
        const sOpen = parseFloat(trade.secondary_open_price as any);
        const orderType = trade.order_type as 'buy' | 'sell';

        // Liquidation protection is checked with emergency prices so lack of full
        // visible depth does not block a risk exit.
        if (emergencyPrices) {
            const maxDrawdown = checkLegDrawdown({ pOpen, sOpen }, emergencyPrices, orderType, config.leverage);
            if (maxDrawdown >= config.maxLegDrawdownPercent) {
                logger.error(this.tag, `🚨 LIQUIDATION TRIGGERED on ${symbol}`);
                const bSpr = calculateOpenSpread(emergencyPrices, 'buy');
                const sSpr = calculateOpenSpread(emergencyPrices, 'sell');
                await this.executeClose(
                    symbol,
                    state,
                    'liquidation',
                    emergencyPrices,
                    bSpr,
                    sSpr,
                    { ...context, signalDetectedAtMs: Date.now() },
                );
                return;
            }
        }

        // Profit check requires strict full-depth pricing. If strictPrices is
        // null, skip profit-taking until the book can support the whole size.
        if (strictPrices) {
            const currentPnL = calculateTruePnL({ pOpen, sOpen }, strictPrices, orderType);
            if (currentPnL >= config.closeThreshold) {
                const bSpr = calculateOpenSpread(strictPrices, 'buy');
                const sSpr = calculateOpenSpread(strictPrices, 'sell');
                await this.executeClose(
                    symbol,
                    state,
                    'profit',
                    strictPrices,
                    bSpr,
                    sSpr,
                    { ...context, signalDetectedAtMs: Date.now() },
                );
            }
        }
    }

    private async executeClose(
        symbol: string,
        state: PairState,
        reason: CloseTriggerReason,
        prices: OrderbookPrices | null,
        currentBuySpread?: number,
        currentSellSpread?: number,
        signalContext?: SignalExecutionContext,
    ) {
        // Close can be triggered by profit target, timeout, shutdown or drawdown.
        // Keep local state until exchange close and Django update both complete.
        if (state.busy) return;
        state.busy = true;
        const closeStartedAtMs = Date.now();

        const trade = state.activeTrade!;
        const orderType = trade.order_type as 'buy' | 'sell';
        const closeIntentId = state.closeIntentId ?? executionJournal.createIntentId('close', symbol);
        state.closeIntentId = closeIntentId;

        logger.info(this.tag, `🟢 CLOSING ${symbol} (${orderType}), reason: ${reason}`);

        try {
            await executionJournal.record(closeIntentId, 'close', 'close_started', symbol, {
                trade_id: trade.id,
                reason,
            });

            const primaryCloseSide = orderType === 'buy' ? 'sell' : 'buy';
            const secondaryCloseSide = orderType === 'buy' ? 'buy' : 'sell';
            const primaryExpectedSide = orderType === 'buy' ? 'long' : 'short';
            const secondaryExpectedSide = orderType === 'buy' ? 'short' : 'long';

            let pPrice = 0, sPrice = 0, pOrder = 'already_closed', sOrder = 'already_closed';

            const info = this.marketInfo.getInfo(symbol);
            const minQty = info?.minQty || 0;

            // 1. Check current positions to make closing idempotent. A missing
            // position is accepted only after a second confirmation to reduce
            // exchange lag / eventual consistency false negatives.
            const [pPos, sPos] = await Promise.all([
                fetchConfirmedPosition(this.primaryClient, symbol, primaryExpectedSide, minQty, this.tag),
                fetchConfirmedPosition(this.secondaryClient, symbol, secondaryExpectedSide, minQty, this.tag),
            ]);

            const pSize = pPos?.size ?? 0;
            const sSize = sPos?.size ?? 0;
            const expectedAmount = parseFloat(trade.amount as any);
            this.lockOnPositionSizeMismatch(symbol, state, trade.id, expectedAmount, pSize, sSize);

            // 2. Execute missing closures only. This avoids flipping positions if
            // a previous close attempt partially succeeded.
            const closePromises: Array<Promise<{
                leg: 'primary' | 'secondary';
                price: number;
                orderId: string;
                commission: number;
                size: number;
                closedAt: string;
            }>> = [];
            const pOpen = parseFloat(trade.primary_open_price as any);
            const sOpen = parseFloat(trade.secondary_open_price as any);
            const shouldClosePrimary = pSize > 0 && pSize >= minQty;
            const shouldCloseSecondary = sSize > 0 && sSize >= minQty;
            const closeOrderSubmitStartedAtMs = shouldClosePrimary || shouldCloseSecondary ? Date.now() : null;

            if (shouldClosePrimary) {
                closePromises.push(
                    this.primaryClient.createMarketOrder(symbol, primaryCloseSide, pSize, { reduceOnly: true }).then(r => ({
                        leg: 'primary' as const,
                        price: r.avgPrice,
                        orderId: r.orderId,
                        commission: r.commission,
                        size: r.filledQty,
                        closedAt: new Date().toISOString(),
                    }))
                );
            } else if (state.partialClose.primary) {
                pPrice = state.partialClose.primary.price;
                pOrder = state.partialClose.primary.orderId;
            } else {
                // If no close order is needed, use current book price or open
                // price for accounting fallback.
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
            }

            if (shouldCloseSecondary) {
                closePromises.push(
                    this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, sSize, { reduceOnly: true }).then(r => ({
                        leg: 'secondary' as const,
                        price: r.avgPrice,
                        orderId: r.orderId,
                        commission: r.commission,
                        size: r.filledQty,
                        closedAt: new Date().toISOString(),
                    }))
                );
            } else if (state.partialClose.secondary) {
                sPrice = state.partialClose.secondary.price;
                sOrder = state.partialClose.secondary.orderId;
            } else {
                // If no close order is needed, use current book price or open
                // price for accounting fallback.
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            const closeResults = await Promise.allSettled(closePromises);
            const closeOrdersSettledAtMs = closeOrderSubmitStartedAtMs !== null ? Date.now() : null;
            if (reason === 'profit' || reason === 'liquidation') {
                this.logLatencyMetrics('close_signal', symbol, {
                    ...this.buildSignalLatencyMetrics(
                        signalContext,
                        closeOrderSubmitStartedAtMs ?? closeStartedAtMs,
                        'close_signal_detected_to_close_submit_start_ms',
                    ),
                    order_submit_start_to_exchange_ack_ms: (
                        closeOrderSubmitStartedAtMs !== null && closeOrdersSettledAtMs !== null
                            ? closeOrdersSettledAtMs - closeOrderSubmitStartedAtMs
                            : null
                    ),
                    primary_order_submitted: shouldClosePrimary,
                    secondary_order_submitted: shouldCloseSecondary,
                });
            }
            const closeErrors: string[] = [];
            for (const result of closeResults) {
                if (result.status === 'rejected') {
                    closeErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
                    continue;
                }

                if (result.value.leg === 'primary') {
                    state.partialClose.primary = {
                        price: result.value.price,
                        orderId: result.value.orderId,
                        commission: result.value.commission,
                        size: result.value.size,
                        closedAt: result.value.closedAt,
                    };
                    await executionJournal.record(closeIntentId, 'close', 'close_leg_filled', symbol, {
                        leg: 'primary',
                        order_id: result.value.orderId,
                        filled_qty: result.value.size,
                        avg_price: result.value.price,
                        commission: result.value.commission,
                    });
                    pPrice = result.value.price;
                    pOrder = result.value.orderId;
                } else {
                    state.partialClose.secondary = {
                        price: result.value.price,
                        orderId: result.value.orderId,
                        commission: result.value.commission,
                        size: result.value.size,
                        closedAt: result.value.closedAt,
                    };
                    await executionJournal.record(closeIntentId, 'close', 'close_leg_filled', symbol, {
                        leg: 'secondary',
                        order_id: result.value.orderId,
                        filled_qty: result.value.size,
                        avg_price: result.value.price,
                        commission: result.value.commission,
                    });
                    sPrice = result.value.price;
                    sOrder = result.value.orderId;
                }
            }

            if (closeErrors.length > 0) {
                throw new Error(`Partial close failed; completed leg state was preserved: ${closeErrors.join('; ')}`);
            }

            // Fallback for execution bugs on exit where an exchange returns an
            // order id but no usable average fill price.
            if (pPrice === 0) {
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
            }
            if (sPrice === 0) {
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            // 3. Calculate results and update Django.
            const amount = expectedAmount;
            const openCommission = parseFloat(trade.open_commission as any) || 0;
            const closeCommission = (
                (state.partialClose.primary?.commission ?? 0)
                + (state.partialClose.secondary?.commission ?? 0)
            );
            const totalCommission = openCommission + closeCommission;
            const primaryAccountingSize = state.partialClose.primary?.size ?? amount;
            const secondaryAccountingSize = state.partialClose.secondary?.size ?? amount;
            const { profitUsdt, profitPercentage } = (
                primaryAccountingSize === amount && secondaryAccountingSize === amount
                    ? calculateRealPnL(pOpen, sOpen, pPrice, sPrice, amount, orderType, totalCommission)
                    : calculateRealPnLByLegSizes(
                        pOpen,
                        sOpen,
                        pPrice,
                        sPrice,
                        primaryAccountingSize,
                        secondaryAccountingSize,
                        orderType,
                        totalCommission,
                    )
            );

            const closeSpread = this.calculateCloseSpread(pPrice, sPrice, orderType);
            const closeStatus = reason === 'profit' ? 'closed' : 'force_closed';

            const closePayload: TradeClosePayload = {
                status: closeStatus as 'closed' | 'force_closed',
                close_reason: reason === 'liquidation' ? 'error' : reason,
                primary_close_price: d(pPrice),
                secondary_close_price: d(sPrice),
                primary_close_order_id: pOrder,
                secondary_close_order_id: sOrder,
                close_spread: d(closeSpread, 4),
                close_commission: d(closeCommission, 6),
                profit_usdt: d(profitUsdt, 6),
                profit_percentage: d(profitPercentage, 4),
                closed_at: new Date().toISOString(),
            };

            const isDbSaved = await this.closeSync.persistCloseTrade(trade.id, closePayload);
            if (!isDbSaved) {
                state.pendingCloseSync = {
                    intentId: closeIntentId,
                    payload: closePayload,
                    reason,
                    nextBaselineBuy: currentBuySpread ?? null,
                    nextBaselineSell: currentSellSpread ?? null,
                };
                await executionJournal.record(closeIntentId, 'close', 'close_sync_pending', symbol, {
                    trade_id: trade.id,
                });
                this.logLatencyMetrics('close_sync', symbol, {
                    full_close_sync_duration_ms: Date.now() - closeStartedAtMs,
                    django_synced: false,
                    trade_id: trade.id,
                });
                logger.error(this.tag, `❌ Close persisted on exchanges for ${symbol}, but Django sync is still pending. Runtime will retry until it succeeds.`);
                return;
            }

            await executionJournal.record(closeIntentId, 'close', 'close_synced', symbol, {
                trade_id: trade.id,
            }).catch((journalError: any) => {
                logger.error(this.tag, `Close trade ${trade.id} is in Django, but execution journal sync failed for ${symbol}: ${journalError.message}`);
            });
            this.logLatencyMetrics('close_sync', symbol, {
                full_close_sync_duration_ms: Date.now() - closeStartedAtMs,
                django_synced: true,
                trade_id: trade.id,
            });
            this.finalizeClosedTrade(symbol, state, currentBuySpread ?? null, currentSellSpread ?? null);

            logger.info(this.tag, `✅ Closed ${symbol} (${reason}). PnL: ${profitUsdt.toFixed(4)} USDT (${profitPercentage.toFixed(3)}%)`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Error closing ${symbol} on exchanges: ${e.message}`);
            await executionJournal.record(closeIntentId, 'close', 'close_failed', symbol, {
                trade_id: trade.id,
                error: e.message,
            }).catch((journalError: any) => logger.error(this.tag, `Failed to append execution journal: ${journalError.message}`));
            // Do not clear local state; next tick will safely retry remaining positions.
        } finally {
            state.busy = false;
            this.scheduleDeferredCheckIfNeeded(symbol);
        }
    }

    private calculateCloseSpread(primaryPrice: number, secondaryPrice: number, orderType: 'buy' | 'sell'): number {
        if (orderType === 'buy') {
            // Close: sell primary, buy secondary.
            return ((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
        } else {
            // Close: buy primary, sell secondary.
            return ((secondaryPrice - primaryPrice) / primaryPrice) * 100;
        }
    }

    private buildSignalLatencyMetrics(
        context: SignalExecutionContext | undefined,
        submitStartedAtMs: number,
        submitMetricName: string = 'signal_detected_to_order_submit_start_ms',
    ): LatencyMetrics {
        if (!context) {
            return {
                socket_update_to_check_start_ms: null,
                check_start_to_signal_detected_ms: null,
                [submitMetricName]: null,
            };
        }

        return {
            socket_update_to_check_start_ms: context.marketEventAtMs === null
                ? null
                : Math.max(0, context.checkStartedAtMs - context.marketEventAtMs),
            check_start_to_signal_detected_ms: Math.max(0, context.signalDetectedAtMs - context.checkStartedAtMs),
            [submitMetricName]: Math.max(0, submitStartedAtMs - context.signalDetectedAtMs),
        };
    }

    private logLatencyMetrics(phase: string, symbol: string, metrics: LatencyMetrics): void {
        logger.info(this.tag, `latency_metrics ${JSON.stringify({
            phase,
            symbol,
            ...metrics,
        })}`);
    }

    private lockOnPositionSizeMismatch(
        symbol: string,
        state: PairState,
        tradeId: number,
        expectedAmount: number,
        primarySize: number,
        secondarySize: number,
    ): boolean {
        if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
            this.riskLock.lock(
                this.reconciliationRiskKey(symbol),
                'position_reconciliation_mismatch',
                `${symbol} active trade ${tradeId} has invalid expected amount ${expectedAmount}.`,
            );
            state.canOpenNewTrades = false;
            return true;
        }

        const tolerance = expectedAmount * (config.positionSizeTolerancePercent / 100);
        const isPrimaryMismatch = primarySize > 0 && Math.abs(primarySize - expectedAmount) > tolerance;
        const isSecondaryMismatch = secondarySize > 0 && Math.abs(secondarySize - expectedAmount) > tolerance;

        if (!isPrimaryMismatch && !isSecondaryMismatch) {
            return false;
        }

        state.canOpenNewTrades = false;
        this.riskLock.lock(
            this.reconciliationRiskKey(symbol),
            'position_size_mismatch',
            `${symbol} trade ${tradeId} expected amount ${expectedAmount}, primary=${primarySize}, secondary=${secondarySize}.`,
        );
        return true;
    }

    // ───────────── Private: Timeout Watchdog ─────────────

    private async checkTimeouts() {
        if (!this.isRunning) return;

        const now = Date.now();

        for (const [symbol, state] of this.states) {
            if (state.unmanagedExposure && !state.busy) {
                await this.retryUnmanagedExposureCleanup(symbol, state);
                continue;
            }

            if (state.pendingCloseSync && !state.busy) {
                await this.flushPendingClose(symbol, state);
                continue;
            }

            if (!state.activeTrade || !state.openedAtMs || state.busy) continue;

            const elapsed = now - state.openedAtMs;
            if (elapsed >= config.maxTradeDurationMs) {
                // Timeout is a hard risk control and uses emergency pricing.
                logger.warn(this.tag, `⏰ Trade timeout for ${symbol} (${Math.round(elapsed / 60000)}min)`);
                const targetCoins = parseFloat(state.activeTrade.amount as any);
                const prices = this.getPrices(symbol, targetCoins, true);
                await this.executeClose(symbol, state, 'timeout', prices);
            }
        }
    }

    // ───────────── Private: Graceful Shutdown ─────────────

    private async reconcileTrackedPositions(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        for (const [symbol, state] of this.states.entries()) {
            if (state.busy) {
                continue;
            }

            if (state.unmanagedExposure) {
                await this.retryUnmanagedExposureCleanup(symbol, state);
                continue;
            }

            if (!state.activeTrade) {
                continue;
            }

            try {
                const trade = state.activeTrade;
                const orderType = trade.order_type as 'buy' | 'sell';
                const primaryExpectedSide = orderType === 'buy' ? 'long' : 'short';
                const secondaryExpectedSide = orderType === 'buy' ? 'short' : 'long';
                const info = this.marketInfo.getInfo(symbol);
                const minQty = info?.minQty || 0;

                const [primaryPosition, secondaryPosition] = await Promise.all([
                    fetchConfirmedPosition(this.primaryClient, symbol, primaryExpectedSide, minQty, this.tag),
                    fetchConfirmedPosition(this.secondaryClient, symbol, secondaryExpectedSide, minQty, this.tag),
                ]);

                if (!primaryPosition || !secondaryPosition) {
                    this.riskLock.lock(
                        this.reconciliationRiskKey(symbol),
                        'position_reconciliation_mismatch',
                        `${symbol} active trade ${trade.id} is missing an expected exchange position.`,
                    );
                    state.canOpenNewTrades = false;
                } else {
                    const expectedAmount = parseFloat(trade.amount as any);
                    const hasSizeMismatch = this.lockOnPositionSizeMismatch(
                        symbol,
                        state,
                        trade.id,
                        expectedAmount,
                        primaryPosition.size,
                        secondaryPosition.size,
                    );

                    if (!hasSizeMismatch) {
                        this.riskLock.clear(this.reconciliationRiskKey(symbol));
                    }
                }
            } catch (error: any) {
                this.riskLock.lock(
                    this.reconciliationRiskKey(symbol),
                    'position_reconciliation_failed',
                    error.message,
                );
                state.canOpenNewTrades = false;
                logger.error(this.tag, `Position reconciliation failed for ${symbol}: ${error.message}`);
            }
        }
    }

    private reconciliationRiskKey(symbol: string): string {
        return `${this.tag}:reconciliation:${symbol}`;
    }

    private executionJournalRiskKey(symbol: string): string {
        return `${this.tag}:journal:${symbol}`;
    }

    private async closeAllPositions(reason: 'shutdown' | 'error') {
        const openTrades = [...this.states.entries()]
            .filter(([_, state]) => (
                state.activeTrade !== null
                || state.pendingCloseSync !== null
                || state.unmanagedExposure !== null
            ));

        if (openTrades.length === 0) return;

        logger.info(this.tag, `Closing ${openTrades.length} positions for ${reason}...`);

        for (const [symbol, state] of openTrades) {
            try {
                if (state.unmanagedExposure) {
                    await this.retryUnmanagedExposureCleanup(symbol, state, true);
                    continue;
                }

                if (state.pendingCloseSync) {
                    await this.flushPendingClose(symbol, state);
                    continue;
                }

                // Shutdown close uses emergency prices because the process should
                // prioritize flattening positions over strict full-depth pricing.
                const targetCoins = parseFloat(state.activeTrade!.amount as any);
                const prices = this.getPrices(symbol, targetCoins, true);
                await this.executeClose(symbol, state, reason, prices);
            } catch (e: any) {
                logger.error(this.tag, `Failed to close ${symbol} during ${reason}: ${e.message}`);
            }
        }

        const remaining = this.getExposureSummary();
        if (remaining.length > 0) {
            throw new Error(`Exposure remains after ${reason}: ${remaining.join(', ')}`);
        }
    }

    private finalizeClosedTrade(
        symbol: string,
        state: PairState,
        nextBaselineBuy: number | null,
        nextBaselineSell: number | null,
    ): void {
        state.activeTrade = null;
        state.openedAtMs = null;
        state.pendingCloseSync = null;
        state.partialClose = {};
        state.closeIntentId = null;
        this.tradeCounter.release();
        this.riskLock.clear(this.reconciliationRiskKey(symbol));
        this.riskLock.clear(this.executionJournalRiskKey(symbol));

        if (nextBaselineBuy !== null && nextBaselineSell !== null) {
            // Reset baselines to the latest spread after a profitable close so
            // the bot does not immediately re-open on stale expansion.
            state.baselineBuy = nextBaselineBuy;
            state.baselineSell = nextBaselineSell;
            return;
        }

        state.baselineBuy = null;
        state.baselineSell = null;
    }

    private async flushPendingClose(symbol: string, state: PairState): Promise<void> {
        if (!state.activeTrade || !state.pendingCloseSync || state.busy) {
            return;
        }

        state.busy = true;

        try {
            const isDbSaved = await this.closeSync.persistCloseTrade(state.activeTrade.id, state.pendingCloseSync.payload);
            if (!isDbSaved) {
                logger.error(this.tag, `❌ Django close sync is still pending for ${symbol}. Exchange positions stay flat, local state remains locked.`);
                return;
            }

            const { reason, nextBaselineBuy, nextBaselineSell } = state.pendingCloseSync;
            await executionJournal.record(state.pendingCloseSync.intentId, 'close', 'close_synced', symbol, {
                trade_id: state.activeTrade.id,
            }).catch((journalError: any) => {
                logger.error(this.tag, `Pending close trade ${state.activeTrade!.id} is in Django, but execution journal sync failed for ${symbol}: ${journalError.message}`);
            });
            this.finalizeClosedTrade(symbol, state, nextBaselineBuy, nextBaselineSell);
            logger.info(this.tag, `✅ Pending Django close sync completed for ${symbol} (${reason}).`);
        } finally {
            state.busy = false;
            this.scheduleDeferredCheckIfNeeded(symbol);
        }
    }
}

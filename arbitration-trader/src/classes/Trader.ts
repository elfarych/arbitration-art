import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { CloseSyncService } from '../services/close-sync-service.js';
import { fetchConfirmedPosition } from '../services/position-recovery.js';
import { shadowRecorder } from '../services/shadow-recorder.js';
import { SignalEngine } from '../services/signal-engine.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { TradeCounter } from './TradeCounter.js';
import { createPairState, type CloseTriggerReason, type PairState } from './trade-state.js';
import type {
    OrderBookProvider,
    OrderbookPrices,
    RuntimeTradePnlSnapshot,
    TradeClosePayload,
    TradeRecord,
} from '../types/index.js';

const COOLDOWN_MS = 30_000; // 30s cooldown after failed order
const TIMEOUT_CHECK_INTERVAL_MS = 10_000; // Check timeouts every 10s

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
    private unsubscribeCallbacks: Array<() => void> = [];
    private scheduledChecks = new Set<string>();
    private runningChecks = new Set<string>();
    private stopResolve: (() => void) | null = null;
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
            if (state && !state.activeTrade) {
                // Reserve a global slot because restored trades already occupy
                // real exchange exposure and must count toward concurrency.
                state.activeTrade = trade;
                state.openedAtMs = new Date(trade.opened_at).getTime();
                this.tradeCounter.forceReserve();
                logger.info(this.tag, `♻️ Restored open trade ${sym} (ID: ${trade.id}, ${trade.order_type})`);
            }
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

        // Start the timeout watchdog separately from websocket ticks so positions
        // can be closed even when a symbol stops receiving frequent book updates.
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);

        const handleUpdate = (symbol: string) => {
            if (this.states.has(symbol)) {
                this.scheduleCheck(symbol);
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
        this.isRunning = false;

        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        for (const unsubscribe of this.unsubscribeCallbacks) {
            unsubscribe();
        }
        this.unsubscribeCallbacks = [];

        if (closePositions) {
            // Used during graceful shutdown to flatten all active positions before
            // the process exits.
            await this.closeAllPositions('shutdown');
        }

        this.stopResolve?.();
        this.stopResolve = null;
        logger.info(this.tag, 'Stopped.');
    }

    private scheduleCheck(symbol: string): void {
        if (
            !this.isRunning ||
            this.scheduledChecks.has(symbol) ||
            this.runningChecks.has(symbol)
        ) {
            return;
        }

        this.scheduledChecks.add(symbol);
        queueMicrotask(() => {
            this.scheduledChecks.delete(symbol);
            if (!this.isRunning || this.runningChecks.has(symbol)) {
                return;
            }

            this.runningChecks.add(symbol);
            void this.checkSpreads(symbol)
                .catch((error: any) => {
                    logger.error(this.tag, `Spread check failed for ${symbol}: ${error.message}`);
                })
                .finally(() => {
                    this.runningChecks.delete(symbol);
                });
        });
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

    // ───────────── Private: Spread Logic ─────────────

    private async checkSpreads(symbol: string) {
        const state = this.states.get(symbol)!;
        // Both websocket loops can call checkSpreads for the same symbol. The
        // busy flag prevents duplicate open/close operations.
        if (state.busy) return;

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
            // Floor using stepSize with floating-point error compensation.
            let amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
            const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
            targetCoins = parseFloat(amount.toFixed(precision));

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
            await this.checkExit(symbol, state, strictPrices, emergencyPrices);
            return;
        }

        if (!state.canOpenNewTrades) {
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
            await this.executeOpen(
                symbol,
                state,
                evaluation.decision.orderType,
                prices,
                evaluation.decision.spread,
                targetCoins,
                evaluation.decision.expectedNetEdge,
                evaluation.decision.fundingCostPercent,
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
    ) {
        state.busy = true;
        let slotReserved = false;

        try {
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

            // Determine order sides for each exchange.
            const primarySide = orderType === 'buy' ? 'buy' : 'sell';
            const secondarySide = orderType === 'buy' ? 'sell' : 'buy';

            // Execute both legs concurrently to reduce legging risk. allSettled
            // lets us inspect partial success and flatten any filled leg.
            const [pSettled, sSettled] = await Promise.allSettled([
                this.primaryClient.createMarketOrder(symbol, primarySide, amount),
                this.secondaryClient.createMarketOrder(symbol, secondarySide, amount),
            ]);

            if (pSettled.status === 'rejected' || sSettled.status === 'rejected') {
                logger.error(this.tag, `❌ Atomic execution failed for ${symbol}! Reverting successful legs...`);
                
                // Roll back the leg that actually opened.
                if (pSettled.status === 'fulfilled') {
                    const revSide = primarySide === 'buy' ? 'sell' : 'buy';
                    // reduceOnly is critical to avoid opening a new opposite
                    // margin position during rollback.
                    await this.primaryClient.createMarketOrder(symbol, revSide, pSettled.value.filledQty, { reduceOnly: true })
                        .catch((error: any) => logger.error(this.tag, `Primary rollback failed for ${symbol}: ${error.message}`));
                }
                if (sSettled.status === 'fulfilled') {
                    const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
                    await this.secondaryClient.createMarketOrder(symbol, revSide, sSettled.value.filledQty, { reduceOnly: true })
                        .catch((error: any) => logger.error(this.tag, `Secondary rollback failed for ${symbol}: ${error.message}`));
                }

                // Insurance against network timeout: an order may have filled
                // even if the API call rejected before returning its response.
                await new Promise(r => setTimeout(r, 1000)); 
                await this.safeHandleOpenCleanup(symbol, orderType);

                if (slotReserved) {
                    this.tradeCounter.release();
                    slotReserved = false;
                }
                state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            const primaryResult = pSettled.value;
            const secondaryResult = sSettled.value;

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

            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, ${this.primaryClient.name}: ${pPriceSafe}, ${this.secondaryClient.name}: ${sPriceSafe}`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open ${symbol}: ${e.message}`);

            // Atomic safety: if an order failed, or if Django API failed after
            // orders were placed, close any opened positions to avoid naked
            // exposure.
            await this.safeHandleOpenCleanup(symbol, orderType);

            if (slotReserved) {
                this.tradeCounter.release();
                slotReserved = false;
            }
            state.baselineBuy = null;
            state.baselineSell = null;
            state.cooldownUntil = Date.now() + COOLDOWN_MS;
        } finally {
            state.busy = false;
        }
    }

    /**
     * Safety cleanup: if open fails for any reason (execution error, Django error),
     * check positions on both exchanges and close them to avoid naked exposure.
     */
    private async handleOpenCleanup(symbol: string, orderType: 'buy' | 'sell') {
        logger.warn(this.tag, `⚠️ Cleanup triggered for ${symbol}. Checking for dangling positions...`);

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
                        await this.primaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
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
                        await this.secondaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
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

        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ CRITICAL: Cleanup error for ${symbol}: ${cleanupErr.message}`);
            throw cleanupErr;
        }
    }

    private async safeHandleOpenCleanup(symbol: string, orderType: 'buy' | 'sell'): Promise<void> {
        try {
            await this.handleOpenCleanup(symbol, orderType);
        } catch (error: any) {
            logger.error(this.tag, `❌ CRITICAL: Cleanup failed for ${symbol}, internal counters were still released: ${error.message}`);
        }
    }

    // ───────────── Private: Close Trade ─────────────

    private async checkExit(
        symbol: string,
        state: PairState,
        strictPrices: OrderbookPrices | null,
        emergencyPrices: OrderbookPrices | null,
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
                await this.executeClose(symbol, state, 'liquidation', emergencyPrices, bSpr, sSpr);
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
                await this.executeClose(symbol, state, 'profit', strictPrices, bSpr, sSpr);
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
    ) {
        // Close can be triggered by profit target, timeout, shutdown or drawdown.
        // Keep local state until exchange close and Django update both complete.
        if (state.busy) return;
        state.busy = true;

        const trade = state.activeTrade!;
        const orderType = trade.order_type as 'buy' | 'sell';

        logger.info(this.tag, `🟢 CLOSING ${symbol} (${orderType}), reason: ${reason}`);

        try {
            const primaryCloseSide = orderType === 'buy' ? 'sell' : 'buy';
            const secondaryCloseSide = orderType === 'buy' ? 'buy' : 'sell';
            const primaryExpectedSide = orderType === 'buy' ? 'long' : 'short';
            const secondaryExpectedSide = orderType === 'buy' ? 'short' : 'long';

            let pPrice = 0, sPrice = 0, pOrder = 'already_closed', sOrder = 'already_closed';
            let closeCommission = 0;

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

            // 2. Execute missing closures only. This avoids flipping positions if
            // a previous close attempt partially succeeded.
            const closePromises = [];
            const pOpen = parseFloat(trade.primary_open_price as any);
            const sOpen = parseFloat(trade.secondary_open_price as any);

            if (pSize > 0 && pSize >= minQty) {
                closePromises.push(
                    this.primaryClient.createMarketOrder(symbol, primaryCloseSide, pSize, { reduceOnly: true }).then(r => {
                        pPrice = r.avgPrice;
                        pOrder = r.orderId;
                        closeCommission += r.commission;
                    })
                );
            } else {
                // If no close order is needed, use current book price or open
                // price for accounting fallback.
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
            }

            if (sSize > 0 && sSize >= minQty) {
                closePromises.push(
                    this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, sSize, { reduceOnly: true }).then(r => {
                        sPrice = r.avgPrice;
                        sOrder = r.orderId;
                        closeCommission += r.commission;
                    })
                );
            } else {
                // If no close order is needed, use current book price or open
                // price for accounting fallback.
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            await Promise.all(closePromises);

            // Fallback for execution bugs on exit where an exchange returns an
            // order id but no usable average fill price.
            if (pPrice === 0 && pSize > 0) {
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
            }
            if (sPrice === 0 && sSize > 0) {
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            // 3. Calculate results and update Django.
            const amount = parseFloat(trade.amount as any);
            const openCommission = parseFloat(trade.open_commission as any) || 0;
            const totalCommission = openCommission + closeCommission;
            const { profitUsdt, profitPercentage } = calculateRealPnL(
                pOpen, sOpen, pPrice, sPrice, amount, orderType, totalCommission,
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
                    payload: closePayload,
                    reason,
                    nextBaselineBuy: currentBuySpread ?? null,
                    nextBaselineSell: currentSellSpread ?? null,
                };
                logger.error(this.tag, `❌ Close persisted on exchanges for ${symbol}, but Django sync is still pending. Runtime will retry until it succeeds.`);
                return;
            }

            this.finalizeClosedTrade(state, currentBuySpread ?? null, currentSellSpread ?? null);

            logger.info(this.tag, `✅ Closed ${symbol} (${reason}). PnL: ${profitUsdt.toFixed(4)} USDT (${profitPercentage.toFixed(3)}%)`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Error closing ${symbol} on exchanges: ${e.message}`);
            // Do not clear local state; next tick will safely retry remaining positions.
        } finally {
            state.busy = false;
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

    // ───────────── Private: Timeout Watchdog ─────────────

    private async checkTimeouts() {
        if (!this.isRunning) return;

        const now = Date.now();

        for (const [symbol, state] of this.states) {
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

    private async closeAllPositions(reason: 'shutdown' | 'error') {
        const openTrades = [...this.states.entries()]
            .filter(([_, state]) => state.activeTrade !== null || state.pendingCloseSync !== null);

        if (openTrades.length === 0) return;

        logger.info(this.tag, `Closing ${openTrades.length} positions for ${reason}...`);

        for (const [symbol, state] of openTrades) {
            try {
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
    }

    private finalizeClosedTrade(
        state: PairState,
        nextBaselineBuy: number | null,
        nextBaselineSell: number | null,
    ): void {
        state.activeTrade = null;
        state.openedAtMs = null;
        state.pendingCloseSync = null;
        this.tradeCounter.release();

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
            this.finalizeClosedTrade(state, nextBaselineBuy, nextBaselineSell);
            logger.info(this.tag, `✅ Pending Django close sync completed for ${symbol} (${reason}).`);
        } finally {
            state.busy = false;
        }
    }
}

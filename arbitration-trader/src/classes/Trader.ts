import { type Exchange } from 'ccxt';
import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { OrderbookPrices, TradeRecord } from '../types/index.js';

/**
 * Per-symbol mutable runtime state.
 *
 * This state lives only inside the Node process. Django is the durable source
 * for trade records, while this map controls current signal calculation,
 * cooldowns and re-entrancy protection.
 */
interface PairState {
    baselineBuy: number | null;
    baselineSell: number | null;
    activeTrade: TradeRecord | null;
    /** Timestamp when the trade was opened (for timeout monitoring) */
    openedAtMs: number | null;
    /** Mutex: prevents concurrent open/close race conditions */
    busy: boolean;
    /** Cooldown timestamp: prevents rapid re-entry after failed orders */
    cooldownUntil: number;
}

/**
 * Shared counter for concurrent trades across all Trader instances.
 * Implements optimistic locking (reserve/release) to prevent async race conditions.
 */
export class TradeCounter {
    private count = 0;

    get current(): number {
        return this.count;
    }

    canOpen(): boolean {
        return this.count < config.maxConcurrentTrades;
    }

    /** Atomically reserve a slot if available */
    reserve(): boolean {
        if (this.count < config.maxConcurrentTrades) {
            this.count++;
            logger.info('TradeCounter', `Reserved trade slot: ${this.count}/${config.maxConcurrentTrades}`);
            return true;
        }
        return false;
    }

    /** Release a reserved slot */
    release(): void {
        this.count = Math.max(0, this.count - 1);
        logger.info('TradeCounter', `Released trade slot: ${this.count}/${config.maxConcurrentTrades}`);
    }

    /** Force increment for restoring existing state */
    forceReserve(): void {
        this.count++;
        logger.info('TradeCounter', `Force reserved (restore): ${this.count}/${config.maxConcurrentTrades}`);
    }
}

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

    constructor(
        public id: number,
        public symbols: string[],
        private primaryWs: Exchange,
        private secondaryWs: Exchange,
        private primaryClient: IExchangeClient,
        private secondaryClient: IExchangeClient,
        private marketInfo: MarketInfoService,
        private tradeCounter: TradeCounter,
    ) {
        this.tag = `Trader-${id}`;
        // Pre-create state for every symbol so runtime checks can use direct
        // Map lookups without creating state while websocket callbacks are active.
        for (const sym of symbols) {
            this.states.set(sym, {
                baselineBuy: null,
                baselineSell: null,
                activeTrade: null,
                openedAtMs: null,
                busy: false,
                cooldownUntil: 0,
            });
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

    /**
     * Start watching orderbooks. Returns a Promise that never resolves
     * (keeps running until `stop()` is called).
     */
    public async start(): Promise<void> {
        logger.info(this.tag, `Starting loops for ${this.symbols.length} pairs...`);

        // Start the timeout watchdog separately from websocket ticks so positions
        // can be closed even when a symbol stops receiving frequent book updates.
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);

        const loops: Promise<void>[] = [];
        for (const symbol of this.symbols) {
            // Every symbol is watched on both exchanges. watchLoop reads the
            // latest orderbook from ccxt.pro's internal cache after each update.
            loops.push(this.watchLoop(this.primaryWs, symbol, this.primaryClient.name));
            loops.push(this.watchLoop(this.secondaryWs, symbol, this.secondaryClient.name));
        }

        await Promise.all(loops);
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

        if (closePositions) {
            // Used during graceful shutdown to flatten all active positions before
            // the process exits.
            await this.closeAllPositions('shutdown');
        }

        logger.info(this.tag, 'Stopped.');
    }

    // ───────────── Private: Watch Loop ─────────────

    private async watchLoop(exchange: Exchange, symbol: string, exName: string) {
        let consecutiveErrors = 0;

        while (this.isRunning) {
            try {
                await exchange.watchOrderBook(symbol, config.orderbookLimit);
                consecutiveErrors = 0;
                await this.checkSpreads(symbol);
            } catch (e: any) {
                consecutiveErrors++;
                // Backoff prevents a bad websocket subscription from spinning
                // hot and flooding logs.
                const delay = Math.min(2000 * consecutiveErrors, 30000);
                logger.error(this.tag, `WS error ${exName} ${symbol} (attempt ${consecutiveErrors}): ${e.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    private getPrices(symbol: string, targetCoinsFallback?: number, isEmergency: boolean = false): OrderbookPrices | null {
        // ccxt.pro keeps orderbooks in memory on the exchange instance. Both
        // primary and secondary books must have at least one bid and ask.
        const bOb = (this.primaryWs as any).orderbooks?.[symbol];
        const yOb = (this.secondaryWs as any).orderbooks?.[symbol];

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
            const bOb = (this.primaryWs as any).orderbooks?.[symbol];
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

        // Idle state: look for entry.
        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices) return;

        const currentBuySpread = calculateOpenSpread(prices, 'buy');
        const currentSellSpread = calculateOpenSpread(prices, 'sell');

        // Baseline EMA tracks normal spread level per direction. Entries require
        // spread expansion above baseline plus OPEN_THRESHOLD.
        const EMA_ALPHA = 0.002;

        if (state.baselineBuy === null) {
            state.baselineBuy = currentBuySpread;
        } else {
            state.baselineBuy = state.baselineBuy * (1 - EMA_ALPHA) + currentBuySpread * EMA_ALPHA;
        }

        if (state.baselineSell === null) {
            state.baselineSell = currentSellSpread;
        } else {
            state.baselineSell = state.baselineSell * (1 - EMA_ALPHA) + currentSellSpread * EMA_ALPHA;
        }

        // Check global concurrent limit first as a cheap read-only guard.
        if (!this.tradeCounter.canOpen()) return;

        // Cooldown prevents immediate re-entry after failed orders/cleanup.
        if (Date.now() < state.cooldownUntil) return;

        if (currentBuySpread >= state.baselineBuy + config.openThreshold) {
            await this.executeOpen(symbol, state, 'buy', prices, currentBuySpread, targetCoins);
            return;
        }
        if (currentSellSpread >= state.baselineSell + config.openThreshold) {
            await this.executeOpen(symbol, state, 'sell', prices, currentSellSpread, targetCoins);
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
        targetCoins: number
    ) {
        state.busy = true;

        try {
            // Reserve a global slot atomically. This closes a race where multiple
            // symbols pass canOpen() before any one of them opens.
            if (!this.tradeCounter.reserve()) {
                logger.debug(this.tag, `Skipping ${symbol}: concurrent trade limit reached just now`);
                return;
            }

            const amount = targetCoins;

            logger.info(this.tag, `🔴 OPENING ${symbol} (${orderType}), amount: ${amount}, spread: ${spread.toFixed(3)}%`);

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
                    await this.primaryClient.createMarketOrder(symbol, revSide, pSettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }
                if (sSettled.status === 'fulfilled') {
                    const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
                    await this.secondaryClient.createMarketOrder(symbol, revSide, sSettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }

                // Insurance against network timeout: an order may have filled
                // even if the API call rejected before returning its response.
                await new Promise(r => setTimeout(r, 1000)); 
                await this.handleOpenCleanup(symbol, orderType);

                this.tradeCounter.release();
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

            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, ${this.primaryClient.name}: ${pPriceSafe}, ${this.secondaryClient.name}: ${sPriceSafe}`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open ${symbol}: ${e.message}`);

            // Atomic safety: if an order failed, or if Django API failed after
            // orders were placed, close any opened positions to avoid naked
            // exposure.
            await this.handleOpenCleanup(symbol, orderType);

            this.tradeCounter.release();
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
        try {
            // Try closing any position that might have been opened on primary.
            try {
                const primaryPositions = await (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of primaryPositions) {
                    if (pos.symbol !== symbol) continue;

                    const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.primaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        logger.info(this.tag, `🧹 Cleaned up ${this.primaryClient.name} position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up ${this.primaryClient.name} position for ${symbol}: ${err.message}`);
            }

            // Try closing any position that might have been opened on secondary.
            try {
                const secondaryPositions = await (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of secondaryPositions) {
                    if (pos.symbol !== symbol) continue;

                    const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.secondaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        logger.info(this.tag, `🧹 Cleaned up ${this.secondaryClient.name} position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up ${this.secondaryClient.name} position for ${symbol}: ${err.message}`);
            }

        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ CRITICAL: Cleanup error for ${symbol}: ${cleanupErr.message}`);
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
        reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation',
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

            let pPrice = 0, sPrice = 0, pOrder = 'already_closed', sOrder = 'already_closed';
            let closeCommission = 0;

            // 1. Check current positions to make closing idempotent. If one leg is
            // already flat, only close the remaining leg and record fallback price.
            const pPositions = await (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]);
            const sPositions = await (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]);

            const pPos = pPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
            const sPos = sPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);

            const pSize = pPos ? Math.abs(Number(pPos.contracts ?? pPos.amount ?? 0)) : 0;
            const sSize = sPos ? Math.abs(Number(sPos.contracts ?? sPos.amount ?? 0)) : 0;

            const info = this.marketInfo.getInfo(symbol);
            const minQty = info?.minQty || 0;

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

            try {
                let isDbSaved = false;
                let retries = 0;
                while (!isDbSaved && retries < 10) {
                    try {
                        // Persist close details with retries. At this point
                        // positions may already be flat, so losing the DB update
                        // would make recovery ambiguous after restart.
                        await api.closeTrade(trade.id, {
                            status: closeStatus as 'closed' | 'force_closed',
                            close_reason: reason === 'liquidation' ? 'error' as any : reason,
                            primary_close_price: d(pPrice),
                            secondary_close_price: d(sPrice),
                            primary_close_order_id: pOrder,
                            secondary_close_order_id: sOrder,
                            close_spread: d(closeSpread, 4),
                            close_commission: d(closeCommission, 6),
                            profit_usdt: d(profitUsdt, 6),
                            profit_percentage: d(profitPercentage, 4),
                            closed_at: new Date().toISOString(),
                        });
                        isDbSaved = true;
                    } catch (dbErr: any) {
                        retries++;
                        logger.error(this.tag, `❌ CRITICAL: Django update failed (ID: ${trade.id}): ${dbErr.message}. Attempt ${retries}/10. Retrying in 5s...`);
                        if (retries < 10) await new Promise(r => setTimeout(r, 5000));
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Unexpected error in DB saving loop: ${err.message}`);
            }

            state.activeTrade = null;
            state.openedAtMs = null;
            this.tradeCounter.release();

            if (currentBuySpread !== undefined && currentSellSpread !== undefined) {
                // Reset baselines to the latest spread after a profitable close so
                // the bot does not immediately re-open on stale expansion.
                state.baselineBuy = currentBuySpread;
                state.baselineSell = currentSellSpread;
            } else {
                state.baselineBuy = null;
                state.baselineSell = null;
            }

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
            .filter(([_, state]) => state.activeTrade !== null);

        if (openTrades.length === 0) return;

        logger.info(this.tag, `Closing ${openTrades.length} positions for ${reason}...`);

        for (const [symbol, state] of openTrades) {
            try {
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
}

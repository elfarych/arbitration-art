import { type Exchange } from 'ccxt';
import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { OrderbookPrices, TradeRecord } from '../types/index.js';

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

export class Trader {
    private tag: string;
    private isRunning = true;
    private states: Map<string, PairState> = new Map();
    private timeoutTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        public id: number,
        public symbols: string[],
        private binanceWs: Exchange,
        private bybitWs: Exchange,
        private binanceClient: IExchangeClient,
        private bybitClient: IExchangeClient,
        private marketInfo: MarketInfoService,
        private tradeCounter: TradeCounter,
    ) {
        this.tag = `Trader-${id}`;
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

        // Start the timeout watchdog
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);

        const loops: Promise<void>[] = [];
        for (const symbol of this.symbols) {
            loops.push(this.watchLoop(this.binanceWs, symbol, 'Binance'));
            loops.push(this.watchLoop(this.bybitWs, symbol, 'Bybit'));
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
                const delay = Math.min(2000 * consecutiveErrors, 30000);
                logger.error(this.tag, `WS error ${exName} ${symbol} (attempt ${consecutiveErrors}): ${e.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    private getPrices(symbol: string, targetCoinsFallback?: number, isClosing: boolean = false): OrderbookPrices | null {
        const bOb = (this.binanceWs as any).orderbooks?.[symbol];
        const yOb = (this.bybitWs as any).orderbooks?.[symbol];

        if (
            !bOb || !yOb ||
            !bOb.bids?.length || !bOb.asks?.length ||
            !yOb.bids?.length || !yOb.asks?.length
        ) {
            return null;
        }

        const info = this.marketInfo.getInfo(symbol);
        // If volume evaluates to 0, calculateVWAP gracefully falls back to absolute Top of Book
        const targetCoins = targetCoinsFallback ?? info?.tradeAmount ?? 0;

        const pBid = calculateVWAP(bOb.bids, targetCoins, isClosing);
        const pAsk = calculateVWAP(bOb.asks, targetCoins, isClosing);
        const sBid = calculateVWAP(yOb.bids, targetCoins, isClosing);
        const sAsk = calculateVWAP(yOb.asks, targetCoins, isClosing);

        if (isNaN(pBid) || isNaN(pAsk) || isNaN(sBid) || isNaN(sAsk)) {
            // Not enough liquidity in the depth to fill even this target size
            logger.debug(this.tag, `📉 Insufficient depth on ${symbol} to fill ${targetCoins} coins. isClosing: ${isClosing}`);
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
        if (state.busy) return;

        const info = this.marketInfo.getInfo(symbol);
        if (!info) return;

        const isClosing = !!state.activeTrade;
        let targetCoins: number;

        if (isClosing) {
            // If in trade, use exact closing volume.
            targetCoins = parseFloat(state.activeTrade!.amount as any);
        } else {
            // Dynamic lot sizing based on current best bid
            const bOb = (this.binanceWs as any).orderbooks?.[symbol];
            const currentPrice = bOb?.bids?.[0]?.[0];
            if (!currentPrice) return;

            const rawAmount = config.tradeAmountUsdt / currentPrice;
            // Floor using stepSize with floating point error compensation
            let amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
            const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
            targetCoins = parseFloat(amount.toFixed(precision));

            if (targetCoins < info.minQty || (targetCoins * currentPrice) < info.minNotional) {
                // Not enough budget to meet exchange layout requirements, wait for price change
                return;
            }
        }
        
        const prices = this.getPrices(symbol, targetCoins, isClosing);
        if (!prices) return;

        const currentBuySpread = calculateOpenSpread(prices, 'buy');
        const currentSellSpread = calculateOpenSpread(prices, 'sell');

        // ==== 1. BASELINE EMA ====
        const EMA_ALPHA = 0.002;

        if (state.baselineBuy === null) {
            state.baselineBuy = currentBuySpread;
        } else if (!isClosing) {
            state.baselineBuy = state.baselineBuy * (1 - EMA_ALPHA) + currentBuySpread * EMA_ALPHA;
        }

        if (state.baselineSell === null) {
            state.baselineSell = currentSellSpread;
        } else if (!isClosing) {
            state.baselineSell = state.baselineSell * (1 - EMA_ALPHA) + currentSellSpread * EMA_ALPHA;
        }

        // ==== 2. IN TRADE: monitor PnL for exit ====
        if (state.activeTrade) {
            await this.checkExit(symbol, state, prices, currentBuySpread, currentSellSpread);
            return;
        }

        // ==== 3. IDLE: look for entry ====
        // Check global concurrent limit (read-only peek)
        if (!this.tradeCounter.canOpen()) return;

        // Check cooldown
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
            // Reserve a slot atomically
            if (!this.tradeCounter.reserve()) {
                logger.debug(this.tag, `Skipping ${symbol}: concurrent trade limit reached just now`);
                return;
            }

            const amount = targetCoins;

            logger.info(this.tag, `🔴 OPENING ${symbol} (${orderType}), amount: ${amount}, spread: ${spread.toFixed(3)}%`);

            // Determine order sides for each exchange
            //   buy  = Long Binance (buy) + Short Bybit (sell)
            //   sell = Short Binance (sell) + Long Bybit (buy)
            const binanceSide = orderType === 'buy' ? 'buy' : 'sell';
            const bybitSide = orderType === 'buy' ? 'sell' : 'buy';

            // Execute both orders concurrently using Promise.allSettled for atomicity safety
            const [bSettled, ySettled] = await Promise.allSettled([
                this.binanceClient.createMarketOrder(symbol, binanceSide, amount),
                this.bybitClient.createMarketOrder(symbol, bybitSide, amount),
            ]);

            if (bSettled.status === 'rejected' || ySettled.status === 'rejected') {
                logger.error(this.tag, `❌ Atomic execution failed for ${symbol}! Reverting successful legs...`);
                
                // Rollback the leg that ACTUALLY opened
                if (bSettled.status === 'fulfilled') {
                    const revSide = binanceSide === 'buy' ? 'sell' : 'buy';
                    // ReduceOnly is critical to avoid opening a new opposite margin position!
                    await this.binanceClient.createMarketOrder(symbol, revSide, bSettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }
                if (ySettled.status === 'fulfilled') {
                    const revSide = bybitSide === 'buy' ? 'sell' : 'buy';
                    await this.bybitClient.createMarketOrder(symbol, revSide, ySettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }

                // Insurance policy against Network Timeout (order fulfilled but API crashed)
                await new Promise(r => setTimeout(r, 1000)); 
                await this.handleOpenCleanup(symbol, orderType);

                this.tradeCounter.release();
                state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return; // Graceful bail out
            }

            const binanceResult = bSettled.value;
            const bybitResult = ySettled.value;

            const totalCommission = d(binanceResult.commission + bybitResult.commission, 6);

            // Record trade in Django with actual fill data
            const tradeRecord = await api.openTrade({
                coin: symbol,
                primary_exchange: 'binance_futures',
                secondary_exchange: 'bybit_futures',
                order_type: orderType,
                status: 'open',
                amount: d(amount),
                leverage: config.leverage,
                primary_open_price: d(binanceResult.avgPrice),
                secondary_open_price: d(bybitResult.avgPrice),
                primary_open_order_id: binanceResult.orderId,
                secondary_open_order_id: bybitResult.orderId,
                open_spread: d(spread, 4),
                open_commission: totalCommission,
            });

            state.activeTrade = tradeRecord;
            state.openedAtMs = Date.now();
            // Note: slot is naturally held until close.

            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, Binance: ${binanceResult.avgPrice}, Bybit: ${bybitResult.avgPrice}`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open ${symbol}: ${e.message}`);

            // ATOMIC SAFETY: If an order failed, or if Django API failed after orders were placed,
            // we must close any opened positions to avoid naked exposure.
            await this.handleOpenCleanup(symbol, orderType);

            this.tradeCounter.release(); // release slot on fail
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

        // We check positions on both exchanges and close any open ones.
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        try {
            // Try closing any position that might have been opened on Binance
            try {
                const binancePositions = await (this.binanceClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of binancePositions) {
                    if (pos.symbol !== symbol) continue; // Defense against CCXT bug sending all symbols

                    const size = Math.abs(Number(pos.contracts ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.binanceClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        logger.info(this.tag, `🧹 Cleaned up Binance position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up Binance position for ${symbol}: ${err.message}`);
            }

            // Try closing any position that might have been opened on Bybit
            try {
                const bybitPositions = await (this.bybitClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of bybitPositions) {
                    if (pos.symbol !== symbol) continue; // Defense against CCXT bug sending all symbols

                    const size = Math.abs(Number(pos.contracts ?? 0));
                    if (size > 0 && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.bybitClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                        logger.info(this.tag, `🧹 Cleaned up Bybit position for ${symbol}`);
                    }
                }
            } catch (err: any) {
                logger.error(this.tag, `Failed to clean up Bybit position for ${symbol}: ${err.message}`);
            }

        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ CRITICAL: Cleanup error for ${symbol}: ${cleanupErr.message}`);
        }
    }

    // ───────────── Private: Close Trade ─────────────

    private async checkExit(
        symbol: string,
        state: PairState,
        prices: OrderbookPrices,
        currentBuySpread: number,
        currentSellSpread: number,
    ) {
        const trade = state.activeTrade!;
        const pOpen = parseFloat(trade.primary_open_price as any);
        const sOpen = parseFloat(trade.secondary_open_price as any);
        const orderType = trade.order_type as 'buy' | 'sell';

        // ==== LIQUIDATION PROTECTION ====
        const maxDrawdown = checkLegDrawdown({ pOpen, sOpen }, prices, orderType, config.leverage);
        if (maxDrawdown >= config.maxLegDrawdownPercent) {
            logger.error(this.tag, `🚨 LIQUIDATION PROTECTION TRIGGERED on ${symbol} (${orderType}). Max leg drawdown: -${maxDrawdown.toFixed(2)}%`);
            await this.executeClose(symbol, state, 'liquidation', prices, currentBuySpread, currentSellSpread);
            return;
        }

        // ==== PROFIT CHECK ====
        const currentPnL = calculateTruePnL({ pOpen, sOpen }, prices, orderType);

        if (currentPnL < config.closeThreshold) return;

        await this.executeClose(symbol, state, 'profit', prices, currentBuySpread, currentSellSpread);
    }

    private async executeClose(
        symbol: string,
        state: PairState,
        reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation',
        prices: OrderbookPrices | null,
        currentBuySpread?: number,
        currentSellSpread?: number,
    ) {
        if (state.busy) return;
        state.busy = true;

        const trade = state.activeTrade!;
        const orderType = trade.order_type as 'buy' | 'sell';

        logger.info(this.tag, `🟢 CLOSING ${symbol} (${orderType}), reason: ${reason}`);

        try {
            const binanceCloseSide = orderType === 'buy' ? 'sell' : 'buy';
            const bybitCloseSide = orderType === 'buy' ? 'buy' : 'sell';

            let bPrice = 0, yPrice = 0, bOrder = 'already_closed', yOrder = 'already_closed';
            let closeCommission = 0;

            // ---- 1. Check current positions to make closing idempotent ----
            const bPositions = await (this.binanceClient as any).ccxtInstance.fetchPositions([symbol]);
            const yPositions = await (this.bybitClient as any).ccxtInstance.fetchPositions([symbol]);

            const bPos = bPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? 0)) > 0);
            const yPos = yPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? 0)) > 0);

            const bSize = bPos ? Math.abs(Number(bPos.contracts ?? 0)) : 0;
            const ySize = yPos ? Math.abs(Number(yPos.contracts ?? 0)) : 0;

            const info = this.marketInfo.getInfo(symbol);
            const minQty = info?.minQty || 0;

            // ---- 2. Execute missing closures ONLY ----
            const closePromises = [];

            if (bSize > 0 && bSize >= minQty) {
                closePromises.push(
                    this.binanceClient.createMarketOrder(symbol, binanceCloseSide, bSize, { reduceOnly: true }).then(r => {
                        bPrice = r.avgPrice;
                        bOrder = r.orderId;
                        closeCommission += r.commission;
                    })
                );
            } else {
                bPrice = parseFloat(trade.primary_open_price as any); // Fallback for reporting
            }

            if (ySize > 0 && ySize >= minQty) {
                closePromises.push(
                    this.bybitClient.createMarketOrder(symbol, bybitCloseSide, ySize, { reduceOnly: true }).then(r => {
                        yPrice = r.avgPrice;
                        yOrder = r.orderId;
                        closeCommission += r.commission;
                    })
                );
            } else {
                yPrice = parseFloat(trade.secondary_open_price as any); // Fallback for reporting
            }

            await Promise.all(closePromises);

            // ---- 3. Calculate Results & Update Django ----
            const amount = parseFloat(trade.amount as any);
            const openCommission = parseFloat(trade.open_commission as any) || 0;
            const totalCommission = openCommission + closeCommission;

            const pOpen = parseFloat(trade.primary_open_price as any);
            const sOpen = parseFloat(trade.secondary_open_price as any);
            const { profitUsdt, profitPercentage } = calculateRealPnL(
                pOpen, sOpen, bPrice, yPrice, amount, orderType, totalCommission,
            );

            const closeSpread = this.calculateCloseSpread(bPrice, yPrice, orderType);
            const closeStatus = reason === 'profit' ? 'closed' : 'force_closed';

            try {
                let isDbSaved = false;
                let retries = 0;
                while (!isDbSaved && retries < 10) {
                    try {
                        await api.closeTrade(trade.id, {
                            status: closeStatus as 'closed' | 'force_closed',
                            close_reason: reason,
                            primary_close_price: d(bPrice),
                            secondary_close_price: d(yPrice),
                            primary_close_order_id: bOrder,
                            secondary_close_order_id: yOrder,
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
            // Close: sell Binance (pBid), buy Bybit (sAsk) → (pBid - sAsk) / sAsk
            return ((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
        } else {
            // Close: buy Binance (pAsk), sell Bybit (sBid) → (sBid - pAsk) / pAsk
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
                const targetCoins = parseFloat(state.activeTrade!.amount as any);
                const prices = this.getPrices(symbol, targetCoins, true);
                await this.executeClose(symbol, state, reason, prices);
            } catch (e: any) {
                logger.error(this.tag, `Failed to close ${symbol} during ${reason}: ${e.message}`);
            }
        }
    }
}

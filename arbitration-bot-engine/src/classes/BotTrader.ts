import { type Exchange } from 'ccxt';
import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { logger } from '../utils/logger.js';
import { config as engineConfig } from '../config.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { OrderbookPrices, OrderResult, TradeRecord } from '../types/index.js';

/**
 * Mutable runtime state for one arbitrage pair.
 *
 * BotConfig is persisted in Django, but these values are process-local and are
 * rebuilt from Django open trades only on startup. The busy flag serializes open
 * and close operations so two websocket ticks cannot submit overlapping orders.
 */
interface PairState {
    activeTrade: TradeRecord | null;
    openedAtMs: number | null;
    busy: boolean;
    cooldownUntil: number;
}

const COOLDOWN_MS = 30_000;
const TIMEOUT_CHECK_INTERVAL_MS = 10_000;
// Maximum time stop() waits for an in-flight open/close to settle before giving
// up. We do not abandon a real-money trade mid-flight, but we also cannot block
// shutdown forever if a leg is stuck.
const STOP_BUSY_WAIT_MS = 30_000;
const FORCE_CLOSE_BUSY_WAIT_MS = 10_000;
// Approximate taker fee per exchange. The engine writes an estimated commission
// to Django immediately on close and replaces it with the actual value once the
// exchange surfaces userTrades. Using a reasonable estimate avoids reporting a
// fake-zero commission during the few seconds the backfill takes.
const ESTIMATED_TAKER_RATE: Record<string, number> = {
    binance: 0.0005,
    bybit: 0.00055,
    mexc: 0.0002,
    gate: 0.0005,
};

function estimateLegFee(name: string, price: number, amount: number): number {
    const rate = ESTIMATED_TAKER_RATE[name.toLowerCase()] ?? 0.0005;
    return Math.max(0, price * amount * rate);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Executes one BotConfig.
 *
 * A BotTrader watches both exchange orderbooks, calculates entry/exit signals,
 * places market orders through REST clients in real mode, and mirrors trade
 * state back to Django. It is intentionally pair-scoped: one instance manages
 * one configured coin and at most one active trade at a time.
 */
export class BotTrader {
    private tag: string;
    private isRunning = true;
    private state: PairState;
    private timeoutTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        public bot: any,
        private primaryWs: Exchange,
        private secondaryWs: Exchange,
        private primaryClient: IExchangeClient,
        private secondaryClient: IExchangeClient,
        private marketInfo: MarketInfoService,
    ) {
        this.tag = `Bot-${bot.id}[${bot.coin}]`;
        this.state = {
            activeTrade: null,
            openedAtMs: null,
            busy: false,
            cooldownUntil: 0,
        };
    }

    public syncConfig(newConfig: any) {
        // Sync is hot: Django can change thresholds or activity flags while the
        // websocket loops are running. Existing open trades keep being monitored
        // with the new exit/drawdown/duration values.
        logger.info(this.tag, `Syncing config changes (Active: ${newConfig.is_active})`);
        this.bot = newConfig;
    }

    public restoreOpenTrades(openTrades: TradeRecord[]): void {
        // The engine only restores the first matching open trade for this coin.
        // This matches the one-active-trade-per-bot design used by state.activeTrade.
        const trade = openTrades.find(t => t.coin === this.bot.coin && t.status === 'open');
        if (trade && !this.state.activeTrade) {
            this.state.activeTrade = trade;
            this.state.openedAtMs = new Date(trade.opened_at).getTime();
            logger.info(this.tag, `♻️ Restored open trade (ID: ${trade.id}, ${trade.order_type})`);
        }
    }

    public async start(): Promise<void> {
        logger.info(this.tag, `Starting loops for ${this.bot.coin}...`);
        // Timeout checks are timer-based because they must still run when spreads
        // are quiet and websocket updates are sparse.
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);

        // Each watchLoop blocks forever while isRunning=true. Promise.all keeps
        // the trader alive until both loops end or one throws outside its own
        // retry handling.
        await Promise.all([
            this.watchLoop(this.primaryWs, this.bot.coin, this.primaryClient.name),
            this.watchLoop(this.secondaryWs, this.bot.coin, this.secondaryClient.name)
        ]);
    }

    public async stop(closePositions: boolean = false): Promise<void> {
        this.isRunning = false;
        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        // Wait for any in-flight open/close to settle before tearing the trader
        // down. Aborting mid-execution risks orphan exchange positions or
        // double-writes when the in-flight async chain finishes after stop().
        const deadline = Date.now() + STOP_BUSY_WAIT_MS;
        while (this.state.busy && Date.now() < deadline) {
            await sleep(50);
        }
        if (this.state.busy) {
            logger.warn(this.tag, `Stop: in-flight operation did not settle within ${STOP_BUSY_WAIT_MS}ms`);
        }

        if (closePositions && this.state.activeTrade) {
            // Used by Engine.stopBot during delete/stop commands from Django.
            await this.closeAllPositions('shutdown');
        }

        // Close ccxt.pro websocket connections so repeated start/stop cycles do
        // not leak file descriptors or memory.
        await Promise.allSettled([
            this.safeWsClose(this.primaryWs),
            this.safeWsClose(this.secondaryWs),
        ]);

        logger.info(this.tag, 'Stopped.');
    }

    private async safeWsClose(ws: Exchange): Promise<void> {
        try {
            const closeable = ws as unknown as { close?: () => Promise<void> | void };
            if (typeof closeable.close === 'function') {
                await closeable.close();
            }
        } catch (e: any) {
            logger.debug(this.tag, `WS close warning: ${e?.message ?? e}`);
        }
    }

    public async forceClose(): Promise<void> {
        if (!this.state.activeTrade) return;
        logger.warn(this.tag, '!!! FORCE CLOSE REQUESTED !!!');

        // Wait briefly if a regular close is already in flight; trying to start
        // a parallel close would be silently dropped by the busy guard, and the
        // user expects the force-close to actually act.
        const deadline = Date.now() + FORCE_CLOSE_BUSY_WAIT_MS;
        while (this.state.busy && Date.now() < deadline) {
            await sleep(50);
        }
        if (this.state.busy) {
            logger.warn(this.tag, 'Force close: busy state did not clear in time; aborting');
            return;
        }
        if (!this.state.activeTrade) {
            // Trade closed while waiting for busy to clear.
            return;
        }

        const targetCoins = parseFloat(this.state.activeTrade.amount as any);
        // Force close uses emergency VWAP so the engine can close with available
        // depth even when the full configured size is no longer visible.
        const prices = this.getPrices(this.bot.coin, targetCoins, true);
        await this.executeClose('force_close', prices);
    }

    private async watchLoop(exchange: Exchange, symbol: string, exName: string) {
        let consecutiveErrors = 0;
        const limit = 50;

        while (this.isRunning) {
            try {
                // ccxt.pro stores the latest orderbook internally on the exchange
                // instance. getPrices() reads that cached orderbook after each
                // successful watch update.
                await exchange.watchOrderBook(symbol, limit);
                consecutiveErrors = 0;
                await this.checkSpreads();
            } catch (e: any) {
                consecutiveErrors++;
                // Simple linear backoff capped at 30s prevents a bad websocket
                // connection from spinning the CPU or flooding logs.
                const delay = Math.min(2000 * consecutiveErrors, 30000);
                logger.error(this.tag, `WS error ${exName} ${symbol}: ${e.message}`);
                await sleep(delay);
            }
        }
    }

    private getPrices(symbol: string, targetCoinsFallback?: number, isEmergency: boolean = false): OrderbookPrices | null {
        // ccxt.pro keeps orderbooks in exchange.orderbooks keyed by ccxt symbol.
        // The code intentionally reads both books only after both sides have at
        // least one bid and ask.
        const bOb = (this.primaryWs as any).orderbooks?.[symbol];
        const yOb = (this.secondaryWs as any).orderbooks?.[symbol];
        if (!bOb?.bids?.length || !bOb?.asks?.length || !yOb?.bids?.length || !yOb?.asks?.length) return null;

        const info = this.marketInfo.getInfo(symbol);
        // Entry uses the precomputed/validated trade amount; close uses the
        // actual recorded trade amount so partial or rounded fills are respected.
        const targetCoins = targetCoinsFallback ?? info?.tradeAmount ?? 0;

        // VWAP is used instead of best bid/ask so spread signals account for the
        // amount this bot intends to trade through the book.
        const pBid = calculateVWAP(bOb.bids, targetCoins, isEmergency);
        const pAsk = calculateVWAP(bOb.asks, targetCoins, isEmergency);
        const sBid = calculateVWAP(yOb.bids, targetCoins, isEmergency);
        const sAsk = calculateVWAP(yOb.asks, targetCoins, isEmergency);

        if (isNaN(pBid) || isNaN(pAsk) || isNaN(sBid) || isNaN(sAsk)) return null;

        return { primaryBid: pBid, primaryAsk: pAsk, secondaryBid: sBid, secondaryAsk: sAsk };
    }

    private computeTargetCoins(currentPrice: number, info: { stepSize: number; minQty: number; minNotional: number }): number {
        // Newer Django bot configs send coin_amount directly. The fallback uses
        // the engine-wide tradeAmountUsdt so behavior matches MarketInfoService.
        const rawAmount = this.bot.coin_amount || (engineConfig.tradeAmountUsdt / currentPrice);
        const amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
        const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
        const targetCoins = parseFloat(amount.toFixed(precision));
        if (targetCoins < info.minQty || (targetCoins * currentPrice) < info.minNotional) return 0;
        return targetCoins;
    }

    private async checkSpreads() {
        // Avoid re-entrancy: both websocket loops call checkSpreads(), so one
        // loop may receive an update while another is already opening/closing.
        if (this.state.busy) return;

        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        if (!info) return;

        const isClosing = !!this.state.activeTrade;

        if (isClosing) {
            const targetCoins = parseFloat(this.state.activeTrade!.amount as any);
            // Strict prices require enough depth for the full close amount and
            // are used for profit-taking. When strict depth is available we can
            // reuse it for the drawdown check as well (the only reason emergency
            // VWAP differs is partial-depth fallback). Emergency is recomputed
            // only when strict is null, which is the same condition that makes
            // calculateVWAP fall back to available depth.
            const strictPrices = this.getPrices(symbol, targetCoins, false);
            const emergencyPrices = strictPrices ?? this.getPrices(symbol, targetCoins, true);
            await this.checkExit(strictPrices, emergencyPrices);
            return;
        }

        // Inactive bots keep monitoring an existing trade for exit conditions
        // but never open a new one.
        if (!this.bot.is_active) return;
        if (Date.now() < this.state.cooldownUntil) return;

        const bOb = (this.primaryWs as any).orderbooks?.[symbol];
        const currentPrice = bOb?.bids?.[0]?.[0];
        if (!currentPrice) return;

        const targetCoins = this.computeTargetCoins(currentPrice, info);
        if (targetCoins <= 0) return;

        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices) return;

        const targetSpread = this.bot.entry_spread;
        const orderType = this.bot.order_type; // 'buy', 'sell', 'auto'

        if (orderType === 'buy' || orderType === 'auto') {
            const currentBuySpread = calculateOpenSpread(prices, 'buy');
            if (currentBuySpread >= targetSpread) {
                await this.executeOpen('buy', prices, currentBuySpread, targetCoins);
                return;
            }
        }

        if (orderType === 'sell' || orderType === 'auto') {
            const currentSellSpread = calculateOpenSpread(prices, 'sell');
            if (currentSellSpread >= targetSpread) {
                await this.executeOpen('sell', prices, currentSellSpread, targetCoins);
                return;
            }
        }
    }

    private async executeOpen(orderType: 'buy' | 'sell', prices: OrderbookPrices, spread: number, targetCoins: number) {
        this.state.busy = true;
        const symbol = this.bot.coin;

        try {
            logger.info(this.tag, `🔴 OPENING (${orderType}), amount: ${targetCoins}, spread: ${spread.toFixed(3)}%`);

            const primarySide = orderType === 'buy' ? 'buy' : 'sell';
            const secondarySide = orderType === 'buy' ? 'sell' : 'buy';

            const isReal = this.bot.trade_mode === 'real';
            // These flags support one-sided live execution while still recording
            // synthetic prices for the disabled leg. Useful during staged rollout
            // or when one exchange leg should only be monitored.
            const runPrimary = isReal && this.bot.trade_on_primary_exchange;
            const runSecondary = isReal && this.bot.trade_on_secondary_exchange;

            // Open both legs concurrently to reduce legging risk.
            const [pSettled, sSettled] = await Promise.allSettled([
                runPrimary ? this.primaryClient.createMarketOrder(symbol, primarySide, targetCoins) : Promise.resolve(this.makeSkippedOrderResult(targetCoins)),
                runSecondary ? this.secondaryClient.createMarketOrder(symbol, secondarySide, targetCoins) : Promise.resolve(this.makeSkippedOrderResult(targetCoins)),
            ]);

            if (pSettled.status === 'rejected' || sSettled.status === 'rejected') {
                const pReason = pSettled.status === 'rejected' ? (pSettled.reason as any)?.message ?? pSettled.reason : 'ok';
                const sReason = sSettled.status === 'rejected' ? (sSettled.reason as any)?.message ?? sSettled.reason : 'ok';
                logger.error(this.tag, `❌ Open leg failure (primary=${pReason}, secondary=${sReason}). Reverting...`);

                // Reverse any leg that did fill so we are not left with one-sided
                // exposure on the exchange.
                const reverseTasks: Promise<any>[] = [];
                if (pSettled.status === 'fulfilled' && runPrimary && pSettled.value.filledQty > 0) {
                    const revSide = primarySide === 'buy' ? 'sell' : 'buy';
                    reverseTasks.push(
                        this.primaryClient.createMarketOrder(symbol, revSide, pSettled.value.filledQty, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Reverse primary failed: ${e.message}`)),
                    );
                }
                if (sSettled.status === 'fulfilled' && runSecondary && sSettled.value.filledQty > 0) {
                    const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
                    reverseTasks.push(
                        this.secondaryClient.createMarketOrder(symbol, revSide, sSettled.value.filledQty, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Reverse secondary failed: ${e.message}`)),
                    );
                }
                await Promise.allSettled(reverseTasks);

                if (isReal) {
                    // After compensation, fetch exchange positions and close any
                    // residue that still meets the exchange minimum quantity.
                    await sleep(1000);
                    await this.handleOpenCleanup();
                }
                this.state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            const primaryResult = pSettled.value;
            const secondaryResult = sSettled.value;

            // In emulator mode, or when a leg is intentionally skipped, exchange
            // results contain 0 prices. Use orderbook VWAP as the recorded price.
            const pPriceSafe = primaryResult.avgPrice > 0 ? primaryResult.avgPrice : (primarySide === 'buy' ? prices.primaryAsk : prices.primaryBid);
            const sPriceSafe = secondaryResult.avgPrice > 0 ? secondaryResult.avgPrice : (secondarySide === 'buy' ? prices.secondaryAsk : prices.secondaryBid);

            let realOpenSpread = spread;
            if (pPriceSafe > 0 && sPriceSafe > 0) {
                // Recalculate spread from actual fill prices when available.
                // This is more accurate than the pre-order signal spread.
                realOpenSpread = orderType === 'buy'
                    ? ((sPriceSafe - pPriceSafe) / pPriceSafe) * 100
                    : ((pPriceSafe - sPriceSafe) / sPriceSafe) * 100;
            }

            const payload: any = {
                // Both Trade and EmulationTrade in Django carry a bot FK; sending
                // it allows queryset-by-bot recovery on engine restart and keeps
                // ownership/audit clean.
                bot: this.bot.id,
                coin: symbol,
                order_type: orderType,
                status: 'open',
                amount: d(targetCoins),
                leverage: this.bot.primary_leverage,
                primary_open_price: d(pPriceSafe),
                secondary_open_price: d(sPriceSafe),
                open_spread: d(realOpenSpread, 4),
                // The engine fixes the timestamp at the moment both legs are
                // confirmed filled. Django's Trade.opened_at is no longer
                // auto_now_add, so this value is what the persisted record uses
                // for timeout calculations after restart recovery.
                opened_at: new Date().toISOString(),
            };

            if (isReal) {
                // Real trades need full exchange metadata and order IDs so
                // Django can audit the execution cycle.
                payload.primary_exchange = `${this.primaryClient.name.toLowerCase()}_futures`;
                payload.secondary_exchange = `${this.secondaryClient.name.toLowerCase()}_futures`;
                payload.primary_open_order_id = primaryResult.orderId;
                payload.secondary_open_order_id = secondaryResult.orderId;
                // Estimated commission gets backfilled by an async task once the
                // exchange surfaces the actual userTrades fee.
                payload.open_commission = d(
                    (runPrimary ? estimateLegFee(this.primaryClient.name, pPriceSafe, targetCoins) : 0)
                    + (runSecondary ? estimateLegFee(this.secondaryClient.name, sPriceSafe, targetCoins) : 0),
                    6,
                );
            }

            logger.debug(this.tag, `📝 Open Payload: ${JSON.stringify(payload)}`);

            let tradeRecord: TradeRecord;
            try {
                tradeRecord = isReal ? await api.openTrade(payload) : await api.openEmulationTrade(payload);
            } catch (e: any) {
                if (isReal) {
                    // Exchange positions exist but Django write failed: we MUST
                    // close them immediately, otherwise the engine will not know
                    // a position is open and may attempt to open another one on
                    // the next favourable tick. This is a real-money safety
                    // critical path.
                    logger.error(this.tag, `🚨 DB write failed AFTER exchange open; rolling back positions: ${e.message}`);
                    await this.rollbackOpenLegs(primaryResult, secondaryResult, primarySide, secondarySide, runPrimary, runSecondary);
                } else {
                    logger.error(this.tag, `❌ DB write failed during emulation open: ${e.message}`);
                }
                this.state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            this.state.activeTrade = tradeRecord;
            this.state.openedAtMs = Date.now();
            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, Spr: ${realOpenSpread.toFixed(3)}%`);

            // Background commission backfill: replace the estimate with the
            // exact fee value once the exchange surfaces it. Fire-and-forget; we
            // do not block the watch loop on this.
            if (isReal) {
                void this.backfillOpenCommission(
                    tradeRecord.id,
                    symbol,
                    runPrimary ? primaryResult.orderId : null,
                    runSecondary ? secondaryResult.orderId : null,
                );
            }

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open: ${e.message}`);
            this.state.cooldownUntil = Date.now() + COOLDOWN_MS;
        } finally {
            this.state.busy = false;
        }
    }

    private makeSkippedOrderResult(targetCoins: number): OrderResult {
        // Synthetic result for legs that are intentionally not executed (because
        // trade_mode is emulation or trade_on_X_exchange is disabled).
        return {
            orderId: 'skipped',
            avgPrice: 0,
            filledQty: targetCoins,
            commission: 0,
            commissionAsset: 'USDT',
            status: 'skipped',
            raw: null,
        };
    }

    private async rollbackOpenLegs(
        primaryResult: OrderResult,
        secondaryResult: OrderResult,
        primarySide: 'buy' | 'sell',
        secondarySide: 'buy' | 'sell',
        runPrimary: boolean,
        runSecondary: boolean,
    ): Promise<void> {
        const symbol = this.bot.coin;
        const tasks: Promise<any>[] = [];
        if (runPrimary && primaryResult.filledQty > 0) {
            const revSide = primarySide === 'buy' ? 'sell' : 'buy';
            tasks.push(
                this.primaryClient.createMarketOrder(symbol, revSide, primaryResult.filledQty, { reduceOnly: true })
                    .catch(e => logger.error(this.tag, `Rollback primary leg failed: ${e.message}`)),
            );
        }
        if (runSecondary && secondaryResult.filledQty > 0) {
            const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
            tasks.push(
                this.secondaryClient.createMarketOrder(symbol, revSide, secondaryResult.filledQty, { reduceOnly: true })
                    .catch(e => logger.error(this.tag, `Rollback secondary leg failed: ${e.message}`)),
            );
        }
        await Promise.allSettled(tasks);
        // Verify and clean residue: the rollback orders themselves can fail or
        // partially fill, and we must not leave a position outstanding.
        await sleep(1000);
        await this.handleOpenCleanup();
    }

    private async handleOpenCleanup() {
        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        try {
            // Cleanup does not trust local order results alone. It asks both
            // exchanges for current positions in parallel and closes whatever
            // exposure remains.
            const [primaryPositions, secondaryPositions] = await Promise.all([
                this.bot.trade_on_primary_exchange
                    ? (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
                this.bot.trade_on_secondary_exchange
                    ? (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
            ]);

            const closeTasks: Promise<any>[] = [];
            for (const pos of (primaryPositions as any[])) {
                const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                if (pos.symbol === symbol && size >= minQty) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    closeTasks.push(
                        this.primaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Cleanup primary close failed: ${e.message}`)),
                    );
                }
            }
            for (const pos of (secondaryPositions as any[])) {
                const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                if (pos.symbol === symbol && size >= minQty) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    closeTasks.push(
                        this.secondaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Cleanup secondary close failed: ${e.message}`)),
                    );
                }
            }
            await Promise.allSettled(closeTasks);
        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ Cleanup error: ${cleanupErr.message}`);
        }
    }

    private async checkExit(strictPrices: OrderbookPrices | null, emergencyPrices: OrderbookPrices | null) {
        const trade = this.state.activeTrade!;
        const pOpen = parseFloat(trade.primary_open_price as any);
        const sOpen = parseFloat(trade.secondary_open_price as any);
        const orderType = trade.order_type as 'buy' | 'sell';

        // Liquidation protection: close if either leg's leveraged drawdown is
        // above the configured per-leg threshold.
        const drawdownLimit = this.bot.max_leg_drawdown_percent || 80.0;

        if (emergencyPrices) {
            const maxDrawdown = checkLegDrawdown({ pOpen, sOpen }, emergencyPrices, orderType, this.bot.primary_leverage);
            if (maxDrawdown >= drawdownLimit) {
                logger.error(this.tag, `🚨 LIQUIDATION TRIGGERED (drawdown ${maxDrawdown.toFixed(2)}%)`);
                await this.executeClose('liquidation', emergencyPrices);
                return;
            }
        }

        if (strictPrices) {
            // Profit exit uses strict liquidity. If the full amount cannot be
            // priced from the current book, skip the profit signal rather than
            // closing on an unreliable partial VWAP.
            const currentPnL = calculateTruePnL({ pOpen, sOpen }, strictPrices, orderType);
            if (currentPnL >= this.bot.exit_spread) {
                await this.executeClose('profit', strictPrices);
            }
        }
    }

    private async executeClose(
        reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation' | 'force_close',
        prices: OrderbookPrices | null,
    ) {
        // Close can be triggered by spread, timeout, shutdown, liquidation guard
        // or manual force close. The busy flag prevents duplicate close orders.
        if (this.state.busy) return;
        this.state.busy = true;

        const trade = this.state.activeTrade!;
        const orderType = trade.order_type as 'buy' | 'sell';
        const symbol = this.bot.coin;

        logger.info(this.tag, `🟢 CLOSING (${orderType}), reason: ${reason}`);

        let primaryResult: OrderResult | null = null;
        let secondaryResult: OrderResult | null = null;

        try {
            const isReal = this.bot.trade_mode === 'real';
            const primaryCloseSide = orderType === 'buy' ? 'sell' : 'buy';
            const secondaryCloseSide = orderType === 'buy' ? 'buy' : 'sell';

            const pOpen = parseFloat(trade.primary_open_price as any);
            const sOpen = parseFloat(trade.secondary_open_price as any);
            const amount = parseFloat(trade.amount as any);

            let pPrice = 0;
            let sPrice = 0;
            let pOrder = 'skipped';
            let sOrder = 'skipped';

            if (isReal) {
                const info = this.marketInfo.getInfo(symbol);
                const minQty = info?.minQty || 0;

                // Fetch both exchange positions in parallel. Failures fall back
                // to the recorded amount; reduceOnly orders are a safety net
                // against double-close if the position no longer exists.
                const [pPositions, sPositions] = await Promise.all([
                    this.bot.trade_on_primary_exchange
                        ? (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                        : Promise.resolve([]),
                    this.bot.trade_on_secondary_exchange
                        ? (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                        : Promise.resolve([]),
                ]);

                let pSize = amount;
                let sSize = amount;

                if (this.bot.trade_on_primary_exchange) {
                    const pPos = (pPositions as any[]).find(p => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
                    if (pPos) {
                        pSize = Math.abs(Number(pPos.contracts ?? pPos.amount ?? 0));
                    }
                    // Else: keep pSize = amount (recorded). reduceOnly prevents
                    // double-close if the position was already cleared externally.
                }

                if (this.bot.trade_on_secondary_exchange) {
                    const sPos = (sPositions as any[]).find(p => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
                    if (sPos) {
                        sSize = Math.abs(Number(sPos.contracts ?? sPos.amount ?? 0));
                    }
                }

                // Submit both close legs in parallel.
                const [pCloseSettled, sCloseSettled] = await Promise.allSettled([
                    this.bot.trade_on_primary_exchange && pSize >= minQty && pSize > 0
                        ? this.primaryClient.createMarketOrder(symbol, primaryCloseSide, pSize, { reduceOnly: true })
                        : Promise.resolve(null),
                    this.bot.trade_on_secondary_exchange && sSize >= minQty && sSize > 0
                        ? this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, sSize, { reduceOnly: true })
                        : Promise.resolve(null),
                ]);

                if (pCloseSettled.status === 'fulfilled' && pCloseSettled.value) {
                    primaryResult = pCloseSettled.value;
                    pPrice = primaryResult.avgPrice;
                    pOrder = primaryResult.orderId;
                } else if (pCloseSettled.status === 'rejected') {
                    logger.error(this.tag, `❌ Primary close leg rejected: ${(pCloseSettled.reason as any)?.message ?? pCloseSettled.reason}`);
                }

                if (sCloseSettled.status === 'fulfilled' && sCloseSettled.value) {
                    secondaryResult = sCloseSettled.value;
                    sPrice = secondaryResult.avgPrice;
                    sOrder = secondaryResult.orderId;
                } else if (sCloseSettled.status === 'rejected') {
                    logger.error(this.tag, `❌ Secondary close leg rejected: ${(sCloseSettled.reason as any)?.message ?? sCloseSettled.reason}`);
                }

                // Safety net for partial-failure closes: verify no residual
                // exchange position remains and attempt one extra reduceOnly
                // close if it does. The exchange may have legitimately rejected
                // a reduceOnly because the position is already 0 (auto-dele,
                // external manual close), in which case verification is a fast
                // no-op. Only run when at least one leg failed so we do not pay
                // for fetchPositions on the happy path.
                if (pCloseSettled.status === 'rejected' || sCloseSettled.status === 'rejected') {
                    await this.verifyAndCloseResidual(symbol, primaryCloseSide, secondaryCloseSide);
                }

                if (pPrice === 0 && this.bot.trade_on_primary_exchange) {
                    pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
                }
                if (sPrice === 0 && this.bot.trade_on_secondary_exchange) {
                    sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
                }
            } else {
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            const openCommission = parseFloat(trade.open_commission as any) || 0;
            // Estimated close commission used for the immediate PATCH so the
            // recorded profit reflects expected fees; backfillCloseCommission
            // replaces it with the exact value once the exchange surfaces fees.
            const estimatedCloseCommission = isReal
                ? (this.bot.trade_on_primary_exchange ? estimateLegFee(this.primaryClient.name, pPrice, amount) : 0)
                + (this.bot.trade_on_secondary_exchange ? estimateLegFee(this.secondaryClient.name, sPrice, amount) : 0)
                : 0;
            const totalCommission = openCommission + estimatedCloseCommission;

            // calculateRealPnL is used for both real and emulation closes so the
            // persisted PnL formula stays consistent across modes.
            const { profitUsdt, profitPercentage } = calculateRealPnL(pOpen, sOpen, pPrice, sPrice, amount, orderType, totalCommission);
            const closeSpread = this.calculateCloseSpread(pPrice, sPrice, orderType);
            const closeStatus = (reason === 'profit' || reason === 'shutdown') ? 'closed' : 'force_closed';

            const payload: any = {
                status: closeStatus,
                primary_close_price: d(pPrice),
                secondary_close_price: d(sPrice),
                close_spread: d(closeSpread, 4),
                profit_percentage: d(profitPercentage, 4),
                closed_at: new Date().toISOString(),
            };

            if (isReal) {
                // Map engine-internal reasons down to Django's Trade.CloseReason
                // choices (profit/timeout/manual/shutdown/error). Liquidation is
                // a loss-driven exit → error; force_close is a user-initiated
                // manual override → manual. Both leave status=force_closed so
                // the trade still reads as non-organic in the UI.
                payload.close_reason =
                    reason === 'liquidation' ? 'error' :
                    reason === 'force_close' ? 'manual' :
                    reason;
                payload.primary_close_order_id = pOrder;
                payload.secondary_close_order_id = sOrder;
                payload.close_commission = d(estimatedCloseCommission, 6);
                payload.profit_usdt = d(profitUsdt, 6);
            }

            logger.debug(this.tag, `📝 Close Payload: ${JSON.stringify(payload)}`);

            try {
                if (isReal) await api.closeTrade(trade.id, payload);
                else await api.closeEmulationTrade(trade.id, payload);
            } catch (e: any) {
                // The exchange positions are already closed (or the close
                // attempt has already been made). We do not try to undo this; we
                // log and clear the in-memory state so the trader does not stay
                // stuck on a now-closed position.
                logger.error(this.tag, `❌ DB write failed during close; exchange already actioned: ${e.message}`);
            }

            this.state.activeTrade = null;
            this.state.openedAtMs = null;

            logger.info(this.tag, `✅ Closed (${reason}). PnL est: ${profitPercentage.toFixed(3)}%`);

            // Background commission backfill: refine the estimated values with
            // the exact fees once the exchange surfaces them.
            if (isReal) {
                void this.backfillCloseCommission(
                    trade.id,
                    symbol,
                    this.bot.trade_on_primary_exchange ? pOrder : null,
                    this.bot.trade_on_secondary_exchange ? sOrder : null,
                    pOpen,
                    sOpen,
                    pPrice,
                    sPrice,
                    amount,
                    orderType,
                    openCommission,
                );
            }

        } catch (e: any) {
            logger.error(this.tag, `❌ Error closing: ${e.message}`);
        } finally {
            this.state.busy = false;
        }
    }

    private async verifyAndCloseResidual(
        symbol: string,
        primaryCloseSide: 'buy' | 'sell',
        secondaryCloseSide: 'buy' | 'sell',
    ): Promise<void> {
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        try {
            const [pPositions, sPositions] = await Promise.all([
                this.bot.trade_on_primary_exchange
                    ? (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
                this.bot.trade_on_secondary_exchange
                    ? (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
            ]);

            const tasks: Promise<any>[] = [];
            for (const pos of (pPositions as any[])) {
                const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                if (pos.symbol === symbol && size >= minQty) {
                    logger.warn(this.tag, `🟡 Residual primary position size=${size}; retrying reduceOnly close`);
                    tasks.push(
                        this.primaryClient.createMarketOrder(symbol, primaryCloseSide, size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `🚨 CRITICAL: residual primary position could not be closed (manual intervention required): ${e.message}`)),
                    );
                }
            }
            for (const pos of (sPositions as any[])) {
                const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                if (pos.symbol === symbol && size >= minQty) {
                    logger.warn(this.tag, `🟡 Residual secondary position size=${size}; retrying reduceOnly close`);
                    tasks.push(
                        this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `🚨 CRITICAL: residual secondary position could not be closed (manual intervention required): ${e.message}`)),
                    );
                }
            }
            await Promise.allSettled(tasks);
        } catch (e: any) {
            logger.error(this.tag, `Residual verification error: ${e.message}`);
        }
    }

    private async backfillOpenCommission(
        tradeId: number,
        symbol: string,
        primaryOrderId: string | null,
        secondaryOrderId: string | null,
    ): Promise<void> {
        try {
            const [pComm, sComm] = await Promise.all([
                primaryOrderId && primaryOrderId !== 'skipped'
                    ? this.primaryClient.fetchOrderCommission(symbol, primaryOrderId).catch(() => 0)
                    : Promise.resolve(0),
                secondaryOrderId && secondaryOrderId !== 'skipped'
                    ? this.secondaryClient.fetchOrderCommission(symbol, secondaryOrderId).catch(() => 0)
                    : Promise.resolve(0),
            ]);
            const total = d(pComm + sComm, 6);
            await api.updateTrade(tradeId, { open_commission: total });
            logger.debug(this.tag, `Backfilled open_commission=${total} for trade ${tradeId}`);
        } catch (e: any) {
            logger.warn(this.tag, `Backfill open commission failed for trade ${tradeId}: ${e.message}`);
        }
    }

    private async backfillCloseCommission(
        tradeId: number,
        symbol: string,
        primaryOrderId: string | null,
        secondaryOrderId: string | null,
        pOpen: number,
        sOpen: number,
        pClose: number,
        sClose: number,
        amount: number,
        orderType: 'buy' | 'sell',
        openCommission: number,
    ): Promise<void> {
        try {
            const [pComm, sComm] = await Promise.all([
                primaryOrderId && primaryOrderId !== 'skipped'
                    ? this.primaryClient.fetchOrderCommission(symbol, primaryOrderId).catch(() => 0)
                    : Promise.resolve(0),
                secondaryOrderId && secondaryOrderId !== 'skipped'
                    ? this.secondaryClient.fetchOrderCommission(symbol, secondaryOrderId).catch(() => 0)
                    : Promise.resolve(0),
            ]);
            const closeCommission = pComm + sComm;
            const total = openCommission + closeCommission;
            const { profitUsdt, profitPercentage } = calculateRealPnL(pOpen, sOpen, pClose, sClose, amount, orderType, total);
            await api.updateTrade(tradeId, {
                close_commission: d(closeCommission, 6),
                profit_usdt: d(profitUsdt, 6),
                profit_percentage: d(profitPercentage, 4),
            });
            logger.debug(this.tag, `Backfilled close_commission=${d(closeCommission, 6)} for trade ${tradeId}`);
        } catch (e: any) {
            logger.warn(this.tag, `Backfill close commission failed for trade ${tradeId}: ${e.message}`);
        }
    }

    private calculateCloseSpread(primaryPrice: number, secondaryPrice: number, orderType: 'buy' | 'sell'): number {
        // Close spread is the reverse of the entry direction. The formula
        // mirrors how calculateOpenSpread chooses bid/ask relationships for each
        // side.
        if (orderType === 'buy') return ((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
        else return ((secondaryPrice - primaryPrice) / primaryPrice) * 100;
    }

    private async checkTimeouts() {
        // Timeouts are a hard risk control. They do not require profit
        // conditions and use emergency prices so stale/partial depth does not
        // block exit.
        if (!this.isRunning || !this.state.activeTrade || !this.state.openedAtMs || this.state.busy) return;

        const maxDurationMinutes = this.bot.max_trade_duration_minutes || 60;
        const maxDurationMs = maxDurationMinutes * 60000;

        const elapsed = Date.now() - this.state.openedAtMs;
        if (elapsed >= maxDurationMs) {
            logger.warn(this.tag, `⏰ Trade timeout (${Math.round(elapsed / 60000)}min)`);
            const targetCoins = parseFloat(this.state.activeTrade.amount as any);
            const prices = this.getPrices(this.bot.coin, targetCoins, true);
            await this.executeClose('timeout', prices);
        }
    }

    private async closeAllPositions(reason: 'shutdown') {
        const targetCoins = parseFloat(this.state.activeTrade!.amount as any);
        const prices = this.getPrices(this.bot.coin, targetCoins, true);
        await this.executeClose(reason, prices);
    }
}

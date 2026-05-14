import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { logger } from '../utils/logger.js';
import { config as engineConfig } from '../config.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketWsClient } from '../exchanges/market-ws.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { OrderbookPrices, OrderResult, TradeRecord } from '../types/index.js';
import type { OrderBookStore, OrderBookSnapshot } from '../market-data/orderbook-store.js';

interface PairState {
    activeTrade: TradeRecord | null;
    openedAtMs: number | null;
    busy: boolean;
    cooldownUntil: number;
    // Total trades the bot ever opened (open + closed + force_closed),
    // initialised from Django on start() so the cap survives engine
    // restarts. Compared against bot.max_trades before each new open.
    tradesOpenedCount: number;
}

const COOLDOWN_MS = 30_000;
// 2s gives the engine enough resolution to honour the 10s minimum
// max_trade_duration_seconds the operator can set in Django, while keeping
// per-bot CPU cost negligible (one timer + one elapsed-time compare per tick).
const TIMEOUT_CHECK_INTERVAL_MS = 2_000;
// Maximum time stop() waits for an in-flight open/close to settle before giving
// up. We do not abandon a real-money trade mid-flight, but we also cannot block
// shutdown forever if a leg is stuck.
const STOP_BUSY_WAIT_MS = 30_000;
const FORCE_CLOSE_BUSY_WAIT_MS = 10_000;
// Minimum interval between repeated "stale orderbook" warnings. The check
// happens on every WS update, so without throttling the same lag would emit
// hundreds of identical warnings per second.
const STALE_LOG_THROTTLE_MS = 5_000;
// Same throttle reasoning as STALE_LOG_THROTTLE_MS: once max_trades is hit,
// every orderbook tick would otherwise emit the same "budget reached" line.
const MAX_TRADES_LOG_THROTTLE_MS = 60_000;
// Approximate taker fee per exchange. The engine writes an estimated commission
// to Django immediately on close and replaces it with the actual value once the
// exchange surfaces userTrades.
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
 * `BotTrader` is event-driven: it subscribes to the shared `OrderBookStore`
 * and reacts to every snapshot update for its symbol on either leg. The
 * native market WS clients push snapshots into the store from each exchange's
 * own connection, so the hot path inside BotTrader is just `store.get()` +
 * spread math + parallel order submit — no ccxt, no extra parsing, no
 * synchronous network I/O before the order leaves the process.
 */
export class BotTrader {
    private readonly tag: string;
    private readonly primaryExchangeKey: string;
    private readonly secondaryExchangeKey: string;
    private isRunning = true;
    private readonly state: PairState;
    private timeoutTimer: ReturnType<typeof setInterval> | null = null;
    private storeUnsubscribe: (() => void) | null = null;
    private lastStaleLogAtMs = 0;
    private lastMaxTradesLogAtMs = 0;

    constructor(
        public bot: any,
        private readonly primaryClient: IExchangeClient,
        private readonly secondaryClient: IExchangeClient,
        private readonly primaryMarketWs: MarketWsClient,
        private readonly secondaryMarketWs: MarketWsClient,
        private readonly orderBookStore: OrderBookStore,
        private readonly marketInfo: MarketInfoService,
    ) {
        this.tag = `Bot-${bot.id}[${bot.coin}]`;
        this.primaryExchangeKey = primaryClient.exchangeKey;
        this.secondaryExchangeKey = secondaryClient.exchangeKey;
        this.state = {
            activeTrade: null,
            openedAtMs: null,
            busy: false,
            cooldownUntil: 0,
            tradesOpenedCount: 0,
        };
    }

    public syncConfig(newConfig: any): void {
        logger.info(this.tag, `Syncing config changes (Active: ${newConfig.is_active})`);
        this.bot = newConfig;
    }

    public restoreOpenTrades(openTrades: TradeRecord[]): void {
        const matching = openTrades.filter(t => t.coin === this.bot.coin && t.status === 'open');
        if (matching.length === 0) return;
        if (matching.length > 1) {
            // Django enforces at most one open trade per (bot, coin) via the
            // engine writing path, so seeing >1 here means either a manual
            // admin edit or a recovery race left ghost rows in the table.
            // Restoring an arbitrary one would silently mis-track the position;
            // surface it loudly so operators can reconcile before trading.
            const ids = matching.map(t => t.id).join(', ');
            logger.error(
                this.tag,
                `🚨 Data inconsistency: ${matching.length} open trades found for ${this.bot.coin} (IDs: ${ids}). ` +
                `Restoring most recent and ignoring older duplicates; reconcile Django state manually.`,
            );
        }
        // Pick the most recently opened record. Older duplicates, if they exist,
        // most likely correspond to positions that were already closed on the
        // exchange but failed to PATCH back to Django — engine cannot recover
        // those automatically.
        const trade = matching.reduce((latest, t) => {
            return new Date(t.opened_at).getTime() > new Date(latest.opened_at).getTime() ? t : latest;
        }, matching[0]!);
        if (!this.state.activeTrade) {
            this.state.activeTrade = trade;
            this.state.openedAtMs = new Date(trade.opened_at).getTime();
            logger.info(this.tag, `♻️ Restored open trade (ID: ${trade.id}, ${trade.order_type})`);
        }
    }

    public async start(): Promise<void> {
        logger.info(this.tag, `Starting market data subscriptions for ${this.bot.coin}...`);

        // Hydrate the all-time opened-trades counter from Django before any
        // WS update can trigger checkSpreads(). The counter is the source of
        // truth for max_trades enforcement; if Django is briefly unreachable
        // we log and start from 0 — the cap is loose for this run but the
        // operator still has BotConfig.is_active to cut things off manually.
        try {
            const isReal = this.bot.trade_mode === 'real';
            this.state.tradesOpenedCount = await api.getTotalTradesCount(this.bot.id, isReal);
            logger.info(
                this.tag,
                `Trades budget: ${this.state.tradesOpenedCount}/${this.bot.max_trades ?? '∞'}`,
            );
        } catch (e: any) {
            logger.warn(this.tag, `getTotalTradesCount failed at start (${e.message}); starting counter from 0`);
            this.state.tradesOpenedCount = 0;
        }

        // Subscribe to the store BEFORE connecting WS clients so the first
        // snapshot that arrives is delivered to checkSpreads().
        this.storeUnsubscribe = this.orderBookStore.onUpdate((exchange, symbol) => {
            if (symbol !== this.bot.coin) return;
            if (exchange !== this.primaryExchangeKey && exchange !== this.secondaryExchangeKey) return;
            // Drop the event if a spread evaluation is already in flight. The
            // next update will pick up the latest state anyway.
            if (this.state.busy) return;
            void this.checkSpreads();
        });

        // Connect both market data WS in parallel to minimize bot startup time.
        await Promise.all([
            this.primaryMarketWs.connect([this.bot.coin]),
            this.secondaryMarketWs.connect([this.bot.coin]),
        ]);

        // Timer-based timeout check still runs even when spreads are quiet and
        // WS updates are sparse — important for max_trade_duration enforcement.
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), TIMEOUT_CHECK_INTERVAL_MS);
    }

    public async stop(closePositions: boolean = false): Promise<void> {
        this.isRunning = false;
        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        if (this.storeUnsubscribe) {
            this.storeUnsubscribe();
            this.storeUnsubscribe = null;
        }

        const deadline = Date.now() + STOP_BUSY_WAIT_MS;
        while (this.state.busy && Date.now() < deadline) {
            await sleep(50);
        }
        if (this.state.busy) {
            logger.warn(this.tag, `Stop: in-flight operation did not settle within ${STOP_BUSY_WAIT_MS}ms`);
        }

        if (closePositions && this.state.activeTrade) {
            await this.closeAllPositions('shutdown');
        }

        await Promise.allSettled([
            this.safeWsClose(this.primaryMarketWs),
            this.safeWsClose(this.secondaryMarketWs),
        ]);

        // Drop snapshots from the shared store so a future bot with the same
        // pair does not see stale data before its own WS clients reconnect.
        this.orderBookStore.clear(this.primaryExchangeKey, this.bot.coin);
        this.orderBookStore.clear(this.secondaryExchangeKey, this.bot.coin);

        logger.info(this.tag, 'Stopped.');
    }

    private async safeWsClose(client: MarketWsClient): Promise<void> {
        try {
            await client.close();
        } catch (e: any) {
            logger.debug(this.tag, `WS close warning: ${e?.message ?? e}`);
        }
    }

    public async forceClose(): Promise<void> {
        if (!this.state.activeTrade) return;
        logger.warn(this.tag, '!!! FORCE CLOSE REQUESTED !!!');

        const deadline = Date.now() + FORCE_CLOSE_BUSY_WAIT_MS;
        while (this.state.busy && Date.now() < deadline) {
            await sleep(50);
        }
        if (this.state.busy) {
            logger.warn(this.tag, 'Force close: busy state did not clear in time; aborting');
            return;
        }
        if (!this.state.activeTrade) return;

        const targetCoins = parseFloat(this.state.activeTrade.amount as any);
        const prices = this.getPrices(this.bot.coin, targetCoins, true);
        await this.executeClose('force_close', prices);
    }

    private getPrices(symbol: string, targetCoinsFallback?: number, isEmergency: boolean = false): OrderbookPrices | null {
        const primarySnap = this.orderBookStore.get(this.primaryExchangeKey, symbol);
        const secondarySnap = this.orderBookStore.get(this.secondaryExchangeKey, symbol);
        if (!isBookReady(primarySnap) || !isBookReady(secondarySnap)) return null;

        // Reject stale snapshots on non-emergency reads. Emergency paths
        // (timeout/liquidation/force-close/shutdown) bypass the check on
        // purpose: closing with stale-but-recent prices is still safer than
        // leaving the position open while waiting for the WS stream to catch up.
        if (!isEmergency && !this.areSnapshotsFresh(primarySnap, secondarySnap)) return null;

        const info = this.marketInfo.getInfo(symbol);
        const targetCoins = targetCoinsFallback ?? info?.tradeAmount ?? 0;

        const pBid = calculateVWAP(primarySnap.bids, targetCoins, isEmergency);
        const pAsk = calculateVWAP(primarySnap.asks, targetCoins, isEmergency);
        const sBid = calculateVWAP(secondarySnap.bids, targetCoins, isEmergency);
        const sAsk = calculateVWAP(secondarySnap.asks, targetCoins, isEmergency);

        if (isNaN(pBid) || isNaN(pAsk) || isNaN(sBid) || isNaN(sAsk)) return null;

        return { primaryBid: pBid, primaryAsk: pAsk, secondaryBid: sBid, secondaryAsk: sAsk };
    }

    private areSnapshotsFresh(primary: OrderBookSnapshot, secondary: OrderBookSnapshot): boolean {
        const now = Date.now();
        const maxAge = engineConfig.orderbookMaxAgeMs;
        const maxSkew = engineConfig.orderbookMaxSkewMs;
        const primaryAge = now - primary.localTimestamp;
        const secondaryAge = now - secondary.localTimestamp;
        const skew = Math.abs(primary.localTimestamp - secondary.localTimestamp);

        if (primaryAge > maxAge || secondaryAge > maxAge) {
            this.logStale(`stale orderbook: ${this.primaryExchangeKey} age=${primaryAge}ms, ${this.secondaryExchangeKey} age=${secondaryAge}ms (max=${maxAge}ms)`);
            return false;
        }
        // maxSkew=0 disables the cross-leg skew check while keeping max-age.
        if (maxSkew > 0 && skew > maxSkew) {
            this.logStale(`orderbook skew: ${this.primaryExchangeKey}↔${this.secondaryExchangeKey} ${skew}ms (max=${maxSkew}ms)`);
            return false;
        }
        return true;
    }

    private logStale(message: string): void {
        const now = Date.now();
        if (now - this.lastStaleLogAtMs < STALE_LOG_THROTTLE_MS) return;
        this.lastStaleLogAtMs = now;
        logger.warn(this.tag, `⏱️ ${message}; skipping non-emergency signals`);
    }

    private computeTargetCoins(currentPrice: number, info: { stepSize: number; minQty: number; minNotional: number }): number {
        const rawAmount = this.bot.coin_amount || (engineConfig.tradeAmountUsdt / currentPrice);
        const amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
        const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
        const targetCoins = parseFloat(amount.toFixed(precision));
        if (targetCoins < info.minQty || (targetCoins * currentPrice) < info.minNotional) return 0;
        return targetCoins;
    }

    private async checkSpreads(): Promise<void> {
        if (this.state.busy) return;

        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        if (!info) return;

        const isClosing = !!this.state.activeTrade;

        if (isClosing) {
            const targetCoins = parseFloat(this.state.activeTrade!.amount as any);
            const strictPrices = this.getPrices(symbol, targetCoins, false);
            const emergencyPrices = strictPrices ?? this.getPrices(symbol, targetCoins, true);
            await this.checkExit(strictPrices, emergencyPrices);
            return;
        }

        if (!this.bot.is_active) return;
        if (Date.now() < this.state.cooldownUntil) return;

        // BotConfig.max_trades caps how many trades the bot can ever open
        // (open + closed + force_closed combined). 0 / undefined / negative
        // means "no cap" — the field is PositiveIntegerField in Django so
        // negatives never reach here in practice, but we guard the cast.
        const maxTrades = Number(this.bot.max_trades);
        if (Number.isFinite(maxTrades) && maxTrades > 0 && this.state.tradesOpenedCount >= maxTrades) {
            const now = Date.now();
            if (now - this.lastMaxTradesLogAtMs > MAX_TRADES_LOG_THROTTLE_MS) {
                logger.info(
                    this.tag,
                    `🛑 max_trades budget reached (${this.state.tradesOpenedCount}/${maxTrades}); skipping new opens`,
                );
                this.lastMaxTradesLogAtMs = now;
            }
            return;
        }

        const primarySnap = this.orderBookStore.get(this.primaryExchangeKey, symbol);
        const currentPrice = primarySnap?.bids?.[0]?.[0];
        if (!currentPrice) return;
        // Reject if the primary book itself is already past max-age; we are
        // about to size an order from its top bid. getPrices() applies the
        // full freshness rule (both legs + cross-leg skew) afterwards.
        if (Date.now() - primarySnap!.localTimestamp > engineConfig.orderbookMaxAgeMs) return;

        const targetCoins = this.computeTargetCoins(currentPrice, info);
        if (targetCoins <= 0) return;

        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices) return;

        const targetSpread = this.bot.entry_spread;
        const orderType = this.bot.order_type;

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

    private async executeOpen(orderType: 'buy' | 'sell', prices: OrderbookPrices, spread: number, targetCoins: number): Promise<void> {
        this.state.busy = true;
        const symbol = this.bot.coin;

        try {
            logger.info(this.tag, `🔴 OPENING (${orderType}), amount: ${targetCoins}, spread: ${spread.toFixed(3)}%`);

            const primarySide = orderType === 'buy' ? 'buy' : 'sell';
            const secondarySide = orderType === 'buy' ? 'sell' : 'buy';

            const isReal = this.bot.trade_mode === 'real';
            const runPrimary = isReal && this.bot.trade_on_primary_exchange;
            const runSecondary = isReal && this.bot.trade_on_secondary_exchange;

            const [pSettled, sSettled] = await Promise.allSettled([
                runPrimary ? this.primaryClient.createMarketOrder(symbol, primarySide, targetCoins) : Promise.resolve(this.makeSkippedOrderResult(targetCoins)),
                runSecondary ? this.secondaryClient.createMarketOrder(symbol, secondarySide, targetCoins) : Promise.resolve(this.makeSkippedOrderResult(targetCoins)),
            ]);

            if (pSettled.status === 'rejected' || sSettled.status === 'rejected') {
                const pReason = pSettled.status === 'rejected' ? (pSettled.reason as any)?.message ?? pSettled.reason : 'ok';
                const sReason = sSettled.status === 'rejected' ? (sSettled.reason as any)?.message ?? sSettled.reason : 'ok';
                logger.error(this.tag, `❌ Open leg failure (primary=${pReason}, secondary=${sReason}). Reverting...`);

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
                    await sleep(1000);
                    await this.handleOpenCleanup();
                }
                this.state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }

            const primaryResult = pSettled.value;
            const secondaryResult = sSettled.value;

            const pPriceSafe = primaryResult.avgPrice > 0 ? primaryResult.avgPrice : (primarySide === 'buy' ? prices.primaryAsk : prices.primaryBid);
            const sPriceSafe = secondaryResult.avgPrice > 0 ? secondaryResult.avgPrice : (secondarySide === 'buy' ? prices.secondaryAsk : prices.secondaryBid);

            let realOpenSpread = spread;
            if (pPriceSafe > 0 && sPriceSafe > 0) {
                realOpenSpread = orderType === 'buy'
                    ? ((sPriceSafe - pPriceSafe) / pPriceSafe) * 100
                    : ((pPriceSafe - sPriceSafe) / sPriceSafe) * 100;
            }

            const payload: any = {
                bot: this.bot.id,
                coin: symbol,
                order_type: orderType,
                status: 'open',
                amount: d(targetCoins),
                leverage: this.bot.primary_leverage,
                primary_open_price: d(pPriceSafe),
                secondary_open_price: d(sPriceSafe),
                open_spread: d(realOpenSpread, 4),
                opened_at: new Date().toISOString(),
            };

            if (isReal) {
                payload.primary_exchange = `${this.primaryExchangeKey}_futures`;
                payload.secondary_exchange = `${this.secondaryExchangeKey}_futures`;
                payload.primary_open_order_id = primaryResult.orderId;
                payload.secondary_open_order_id = secondaryResult.orderId;
                payload.open_commission = d(
                    (runPrimary ? estimateLegFee(this.primaryExchangeKey, pPriceSafe, targetCoins) : 0)
                    + (runSecondary ? estimateLegFee(this.secondaryExchangeKey, sPriceSafe, targetCoins) : 0),
                    6,
                );
            }

            // Avoid eagerly stringifying the payload — JSON.stringify on the
            // hot path adds measurable latency per trade open. The orderId,
            // spread and price are sufficient to trace; the full payload is
            // recoverable from Django by trade ID.
            logger.debug(
                this.tag,
                `📝 Open payload: amount=${payload.amount} spread=${payload.open_spread} ` +
                `pPrice=${payload.primary_open_price} sPrice=${payload.secondary_open_price}`,
            );

            let tradeRecord: TradeRecord;
            try {
                tradeRecord = isReal ? await api.openTrade(payload) : await api.openEmulationTrade(payload);
            } catch (e: any) {
                if (isReal) {
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
            this.state.tradesOpenedCount += 1;
            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, Spr: ${realOpenSpread.toFixed(3)}%`);

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
        await sleep(1000);
        await this.handleOpenCleanup();
    }

    private async handleOpenCleanup(): Promise<void> {
        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        try {
            const [primaryPositions, secondaryPositions] = await Promise.all([
                this.bot.trade_on_primary_exchange
                    ? this.primaryClient.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
                this.bot.trade_on_secondary_exchange
                    ? this.secondaryClient.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
            ]);

            const closeTasks: Promise<any>[] = [];
            for (const pos of primaryPositions) {
                if (pos.symbol === symbol && pos.size >= minQty) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    closeTasks.push(
                        this.primaryClient.createMarketOrder(symbol, side, pos.size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Cleanup primary close failed: ${e.message}`)),
                    );
                }
            }
            for (const pos of secondaryPositions) {
                if (pos.symbol === symbol && pos.size >= minQty) {
                    const side = pos.side === 'long' ? 'sell' : 'buy';
                    closeTasks.push(
                        this.secondaryClient.createMarketOrder(symbol, side, pos.size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `Cleanup secondary close failed: ${e.message}`)),
                    );
                }
            }
            await Promise.allSettled(closeTasks);
        } catch (cleanupErr: any) {
            logger.error(this.tag, `❌ Cleanup error: ${cleanupErr.message}`);
        }
    }

    private async checkExit(strictPrices: OrderbookPrices | null, emergencyPrices: OrderbookPrices | null): Promise<void> {
        const trade = this.state.activeTrade!;
        const pOpen = parseFloat(trade.primary_open_price as any);
        const sOpen = parseFloat(trade.secondary_open_price as any);
        const orderType = trade.order_type as 'buy' | 'sell';

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
            const currentPnL = calculateTruePnL({ pOpen, sOpen }, strictPrices, orderType);
            if (currentPnL >= this.bot.exit_spread) {
                await this.executeClose('profit', strictPrices);
            }
        }
    }

    private async executeClose(
        reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation' | 'force_close',
        prices: OrderbookPrices | null,
    ): Promise<void> {
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

                const [pPositions, sPositions] = await Promise.all([
                    this.bot.trade_on_primary_exchange
                        ? this.primaryClient.fetchPositions([symbol]).catch(() => [])
                        : Promise.resolve([]),
                    this.bot.trade_on_secondary_exchange
                        ? this.secondaryClient.fetchPositions([symbol]).catch(() => [])
                        : Promise.resolve([]),
                ]);

                let pSize = amount;
                let sSize = amount;

                if (this.bot.trade_on_primary_exchange) {
                    const pPos = pPositions.find(p => p.symbol === symbol && p.size > 0);
                    if (pPos) pSize = pPos.size;
                }

                if (this.bot.trade_on_secondary_exchange) {
                    const sPos = sPositions.find(p => p.symbol === symbol && p.size > 0);
                    if (sPos) sSize = sPos.size;
                }

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
            const estimatedCloseCommission = isReal
                ? (this.bot.trade_on_primary_exchange ? estimateLegFee(this.primaryExchangeKey, pPrice, amount) : 0)
                + (this.bot.trade_on_secondary_exchange ? estimateLegFee(this.secondaryExchangeKey, sPrice, amount) : 0)
                : 0;
            const totalCommission = openCommission + estimatedCloseCommission;

            const { profitUsdt, profitPercentage } = calculateRealPnL(pOpen, sOpen, pPrice, sPrice, amount, orderType, totalCommission);
            const closeSpread = this.calculateCloseSpread(pPrice, sPrice, orderType);
            // EmulationTrade.Status in Django only defines `open` / `closed` —
            // there is no `force_closed` choice because there is no real-money
            // distinction in emulator (no orders, no partial fills). Sending
            // `force_closed` here triggers a serializer ValidationError and the
            // trade stays open in Django forever. RealTrade keeps the original
            // mapping; the close reason is still preserved on its `close_reason`
            // field, so no information is lost there.
            const closeStatus = isReal && !(reason === 'profit' || reason === 'shutdown')
                ? 'force_closed'
                : 'closed';

            const payload: any = {
                status: closeStatus,
                primary_close_price: d(pPrice),
                secondary_close_price: d(sPrice),
                close_spread: d(closeSpread, 4),
                profit_percentage: d(profitPercentage, 4),
                closed_at: new Date().toISOString(),
            };

            if (isReal) {
                payload.close_reason =
                    reason === 'liquidation' ? 'error' :
                    reason === 'force_close' ? 'manual' :
                    reason;
                payload.primary_close_order_id = pOrder;
                payload.secondary_close_order_id = sOrder;
                payload.close_commission = d(estimatedCloseCommission, 6);
                payload.profit_usdt = d(profitUsdt, 6);
            }

            logger.debug(
                this.tag,
                `📝 Close payload: status=${payload.status} reason=${payload.close_reason ?? '-'} ` +
                `pPrice=${payload.primary_close_price} sPrice=${payload.secondary_close_price} ` +
                `profit=${payload.profit_usdt ?? '-'}`,
            );

            // The exchange has already actioned the close — if Django write
            // fails the position state is correct on the exchange but Django
            // still considers the trade open, which prevents the next entry
            // and confuses recovery on restart. Retry the PATCH a few times
            // with linear backoff before giving up; only then leave the
            // 🚨 CRITICAL log for operator follow-up.
            const closeWriteOk = await this.persistCloseWithRetry(trade.id, payload, isReal);
            if (!closeWriteOk) {
                logger.error(
                    this.tag,
                    `🚨 CRITICAL: failed to PATCH Django trade ${trade.id} after exchange close. ` +
                    `Position is closed on exchange but Django still shows status=open. ` +
                    `Manual reconciliation required.`,
                );
            }

            this.state.activeTrade = null;
            this.state.openedAtMs = null;

            logger.info(this.tag, `✅ Closed (${reason}). PnL est: ${profitPercentage.toFixed(3)}%`);

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
            // primaryResult / secondaryResult are kept available for diagnostics
            // by the function's local scope until it exits; nothing else
            // observes them outside the success path.
            void primaryResult;
            void secondaryResult;
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
                    ? this.primaryClient.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
                this.bot.trade_on_secondary_exchange
                    ? this.secondaryClient.fetchPositions([symbol]).catch(() => [])
                    : Promise.resolve([]),
            ]);

            const tasks: Promise<any>[] = [];
            for (const pos of pPositions) {
                if (pos.symbol === symbol && pos.size >= minQty) {
                    logger.warn(this.tag, `🟡 Residual primary position size=${pos.size}; retrying reduceOnly close`);
                    tasks.push(
                        this.primaryClient.createMarketOrder(symbol, primaryCloseSide, pos.size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `🚨 CRITICAL: residual primary position could not be closed: ${e.message}`)),
                    );
                }
            }
            for (const pos of sPositions) {
                if (pos.symbol === symbol && pos.size >= minQty) {
                    logger.warn(this.tag, `🟡 Residual secondary position size=${pos.size}; retrying reduceOnly close`);
                    tasks.push(
                        this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, pos.size, { reduceOnly: true })
                            .catch(e => logger.error(this.tag, `🚨 CRITICAL: residual secondary position could not be closed: ${e.message}`)),
                    );
                }
            }
            await Promise.allSettled(tasks);
        } catch (e: any) {
            logger.error(this.tag, `Residual verification error: ${e.message}`);
        }
    }

    private async persistCloseWithRetry(
        tradeId: number,
        payload: any,
        isReal: boolean,
    ): Promise<boolean> {
        // Three attempts with linear backoff cover the most common transient
        // failure mode (Django worker restart, brief network hiccup). Beyond
        // that, the failure is likely structural (auth, validation) and more
        // retries would only delay operator notification.
        const delaysMs = [0, 500, 1500];
        let lastError: unknown = null;
        for (let attempt = 0; attempt < delaysMs.length; attempt++) {
            const delay = delaysMs[attempt];
            if (delay && delay > 0) await sleep(delay);
            try {
                if (isReal) await api.closeTrade(tradeId, payload);
                else await api.closeEmulationTrade(tradeId, payload);
                if (attempt > 0) {
                    logger.warn(
                        this.tag,
                        `Trade ${tradeId} close PATCH succeeded on attempt ${attempt + 1}/${delaysMs.length}`,
                    );
                }
                return true;
            } catch (e: any) {
                lastError = e;
                logger.warn(
                    this.tag,
                    `Close PATCH attempt ${attempt + 1}/${delaysMs.length} failed for trade ${tradeId}: ${e?.message ?? e}`,
                );
            }
        }
        logger.error(
            this.tag,
            `Close PATCH exhausted retries for trade ${tradeId}: ${(lastError as any)?.message ?? lastError}`,
        );
        return false;
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
        if (orderType === 'buy') return ((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
        return ((secondaryPrice - primaryPrice) / primaryPrice) * 100;
    }

    private async checkTimeouts(): Promise<void> {
        if (!this.isRunning || !this.state.activeTrade || !this.state.openedAtMs || this.state.busy) return;

        const maxDurationSeconds = this.bot.max_trade_duration_seconds || 3600;
        const maxDurationMs = maxDurationSeconds * 1000;

        const elapsed = Date.now() - this.state.openedAtMs;
        if (elapsed >= maxDurationMs) {
            logger.warn(this.tag, `⏰ Trade timeout (${Math.round(elapsed / 1000)}s)`);
            const targetCoins = parseFloat(this.state.activeTrade.amount as any);
            const prices = this.getPrices(this.bot.coin, targetCoins, true);
            await this.executeClose('timeout', prices);
        }
    }

    private async closeAllPositions(reason: 'shutdown'): Promise<void> {
        const targetCoins = parseFloat(this.state.activeTrade!.amount as any);
        const prices = this.getPrices(this.bot.coin, targetCoins, true);
        await this.executeClose(reason, prices);
    }
}

function isBookReady(snapshot: OrderBookSnapshot | null): snapshot is OrderBookSnapshot {
    return !!snapshot && snapshot.bids.length > 0 && snapshot.asks.length > 0;
}

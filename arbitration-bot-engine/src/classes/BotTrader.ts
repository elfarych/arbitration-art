import { type Exchange } from 'ccxt';
import { calculateOpenSpread, calculateTruePnL, calculateRealPnL, d, checkLegDrawdown, calculateVWAP } from '../utils/math.js';
import { api } from '../services/api.js';
import { logger } from '../utils/logger.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { MarketInfoService } from '../services/market-info.js';
import type { OrderbookPrices, TradeRecord } from '../types/index.js';

/**
 * Mutable runtime state for one arbitrage pair.
 *
 * BotConfig is persisted in Django, but these values are process-local and are
 * rebuilt from Django open trades only on startup. The busy flag serializes open
 * and close operations so two websocket ticks cannot submit overlapping orders.
 */
interface PairState {
    baselineBuy: number | null;
    baselineSell: number | null;
    activeTrade: TradeRecord | null;
    openedAtMs: number | null;
    busy: boolean;
    cooldownUntil: number;
}

const COOLDOWN_MS = 30_000;
const TIMEOUT_CHECK_INTERVAL_MS = 10_000;

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
            baselineBuy: null,
            baselineSell: null,
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

        if (closePositions && this.state.activeTrade) {
            // Used by Engine.stopBot during delete/stop commands from Django.
            await this.closeAllPositions('shutdown');
        }
        logger.info(this.tag, 'Stopped.');
    }

    public async forceClose(): Promise<void> {
        if (!this.state.activeTrade) return;
        logger.warn(this.tag, '!!! FORCE CLOSE REQUESTED !!!');
        const targetCoins = parseFloat(this.state.activeTrade.amount as any);
        // Force close uses emergency VWAP so the engine can close with available
        // depth even when the full configured size is no longer visible.
        const prices = this.getPrices(this.bot.coin, targetCoins, true);
        await this.executeClose('force_close' as any, prices);
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
                await new Promise(r => setTimeout(r, delay));
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

    private async checkSpreads() {
        // Avoid re-entrancy: both websocket loops call checkSpreads(), so one
        // loop may receive an update while another is already opening/closing.
        if (this.state.busy) return;
        
        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        if (!info) return;

        const isClosing = !!this.state.activeTrade;
        let targetCoins: number;

        if (isClosing) {
            // Closing always targets the amount persisted on the open trade.
            targetCoins = parseFloat(this.state.activeTrade!.amount as any);
        } else {
            const bOb = (this.primaryWs as any).orderbooks?.[symbol];
            const currentPrice = bOb?.bids?.[0]?.[0];
            if (!currentPrice) return;

            const rawAmount = this.bot.coin_amount || (50 / currentPrice); 
            // Newer Django bot configs send coin_amount directly. The fallback
            // keeps older configs usable by deriving about 50 USDT of notional.
            let amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
            const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
            targetCoins = parseFloat(amount.toFixed(precision));

            if (targetCoins < info.minQty || (targetCoins * currentPrice) < info.minNotional) return;
        }
        
        if (isClosing) {
            // Strict prices require enough depth for the full close amount and
            // are used for profit-taking. Emergency prices may use partial depth
            // and are used for risk exits.
            const strictPrices = this.getPrices(symbol, targetCoins, false);
            const emergencyPrices = this.getPrices(symbol, targetCoins, true);
            await this.checkExit(strictPrices, emergencyPrices);
            return;
        }

        // Inactive bots keep monitoring an existing trade for exit conditions but
        // never open a new one.
        if (!this.bot.is_active) return;

        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices || Date.now() < this.state.cooldownUntil) return;

        const currentBuySpread = calculateOpenSpread(prices, 'buy');
        const currentSellSpread = calculateOpenSpread(prices, 'sell');

        const EMA_ALPHA = 0.002;
        // Baselines are currently tracked but not used for signal decisions.
        // They are useful future hooks for adaptive spread thresholds.
        if (this.state.baselineBuy === null) this.state.baselineBuy = currentBuySpread;
        else this.state.baselineBuy = this.state.baselineBuy * (1 - EMA_ALPHA) + currentBuySpread * EMA_ALPHA;

        if (this.state.baselineSell === null) this.state.baselineSell = currentSellSpread;
        else this.state.baselineSell = this.state.baselineSell * (1 - EMA_ALPHA) + currentSellSpread * EMA_ALPHA;

        const targetSpread = this.bot.entry_spread; 
        const orderType = this.bot.order_type; // 'buy', 'sell'
        
        if (orderType === 'buy' || orderType === 'auto') {
            if (currentBuySpread >= targetSpread) {
                 await this.executeOpen('buy', prices, currentBuySpread, targetCoins);
                 return;
            }
        }
        
        if (orderType === 'sell' || orderType === 'auto') {
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
            // synthetic prices for the disabled leg. That is useful during staged
            // rollout or when one exchange leg should only be monitored.
            const runPrimary = isReal && this.bot.trade_on_primary_exchange;
            const runSecondary = isReal && this.bot.trade_on_secondary_exchange;

            // Open both legs concurrently to reduce legging risk. Promise.allSettled
            // lets the engine inspect partial success and attempt compensation.
            const [pSettled, sSettled] = await Promise.allSettled([
                runPrimary ? this.primaryClient.createMarketOrder(symbol, primarySide, targetCoins) : Promise.resolve({ avgPrice: 0, orderId: runPrimary ? undefined : 'skipped', commission: 0, filledQty: targetCoins }),
                runSecondary ? this.secondaryClient.createMarketOrder(symbol, secondarySide, targetCoins) : Promise.resolve({ avgPrice: 0, orderId: runSecondary ? undefined : 'skipped', commission: 0, filledQty: targetCoins }),
            ]);

            if (pSettled.status === 'rejected' || sSettled.status === 'rejected') {
                logger.error(this.tag, `❌ Atomic execution failed! Reverting successful legs...`);
                // If only one real leg filled, immediately submit a reduce-only
                // opposite order to flatten the accidental exposure.
                if (pSettled.status === 'fulfilled' && runPrimary) {
                    const revSide = primarySide === 'buy' ? 'sell' : 'buy';
                    await this.primaryClient.createMarketOrder(symbol, revSide, pSettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }
                if (sSettled.status === 'fulfilled' && runSecondary) {
                    const revSide = secondarySide === 'buy' ? 'sell' : 'buy';
                    await this.secondaryClient.createMarketOrder(symbol, revSide, sSettled.value.filledQty, { reduceOnly: true }).catch(console.error);
                }
                
                if (isReal) {
                    // After compensation, fetch exchange positions and close any
                    // residue that still meets the exchange minimum quantity.
                    await new Promise(r => setTimeout(r, 1000));
                    await this.handleOpenCleanup(primarySide, secondarySide);
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

            const totalCommission = d(primaryResult.commission + secondaryResult.commission, 6);

            let realOpenSpread = spread;
            if (pPriceSafe > 0 && sPriceSafe > 0) {
                // Recalculate spread from actual fill prices when available. This
                // is more accurate than the pre-order signal spread.
                realOpenSpread = orderType === 'buy'
                    ? ((sPriceSafe - pPriceSafe) / pPriceSafe) * 100
                    : ((pPriceSafe - sPriceSafe) / sPriceSafe) * 100;
            }

            const payload: any = {
                // EmulationTrade requires bot; real Trade ignores it because the
                // current Django real-trade model has no bot relation.
                bot: this.bot.id,
                coin: symbol,
                order_type: orderType,
                status: 'open',
                amount: d(targetCoins),
                leverage: this.bot.primary_leverage, 
                primary_open_price: d(pPriceSafe),
                secondary_open_price: d(sPriceSafe),
                open_spread: d(realOpenSpread, 4),
            };

            if (isReal) {
                // Real trades need full exchange metadata and order IDs so Django
                // can audit the execution cycle.
                payload.primary_exchange = `${this.primaryClient.name.toLowerCase()}_futures`;
                payload.secondary_exchange = `${this.secondaryClient.name.toLowerCase()}_futures`;
                payload.primary_open_order_id = primaryResult.orderId;
                payload.secondary_open_order_id = secondaryResult.orderId;
                payload.open_commission = totalCommission;
            }

            logger.info(this.tag, `📝 Open Payload Details:\n${JSON.stringify(payload, null, 2)}`);

            const tradeRecord = isReal ? await api.openTrade(payload) : await api.openEmulationTrade(payload);

            this.state.activeTrade = tradeRecord;
            this.state.openedAtMs = Date.now();
            logger.info(this.tag, `✅ Opened ${symbol} (${orderType}). DB ID: ${tradeRecord.id}, Spr: ${realOpenSpread.toFixed(3)}%`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Failed to open: ${e.message}`);
            this.state.cooldownUntil = Date.now() + COOLDOWN_MS;
        } finally {
            this.state.busy = false;
        }
    }

    private async handleOpenCleanup(primarySide: 'buy'|'sell', secondarySide: 'buy'|'sell') {
        const symbol = this.bot.coin;
        const info = this.marketInfo.getInfo(symbol);
        const minQty = info?.minQty || 0;
        try {
            // Cleanup does not trust local order results alone. It asks both
            // exchanges for current positions and closes whatever exposure remains.
            if (this.bot.trade_on_primary_exchange) {
                const primaryPositions = await (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of primaryPositions) {
                    const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                    if (pos.symbol === symbol && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.primaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                    }
                }
            }
            if (this.bot.trade_on_secondary_exchange) {
                const secondaryPositions = await (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]);
                for (const pos of secondaryPositions) {
                    const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
                    if (pos.symbol === symbol && size >= minQty) {
                        const side = pos.side === 'long' ? 'sell' : 'buy';
                        await this.secondaryClient.createMarketOrder(symbol, side, size, { reduceOnly: true });
                    }
                }
            }
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
                logger.error(this.tag, `🚨 LIQUIDATION TRIGGERED`);
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

    private async executeClose(reason: 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation' | 'force_close', prices: OrderbookPrices | null) {
        // Close can be triggered by spread, timeout, shutdown, liquidation guard
        // or manual force close. The busy flag prevents duplicate close orders.
        if (this.state.busy) return;
        this.state.busy = true;

        const trade = this.state.activeTrade!;
        const orderType = trade.order_type as 'buy' | 'sell';
        const symbol = this.bot.coin;
        
        logger.info(this.tag, `🟢 CLOSING (${orderType}), reason: ${reason}`);

        try {
            const isReal = this.bot.trade_mode === 'real';
            const primaryCloseSide = orderType === 'buy' ? 'sell' : 'buy';
            const secondaryCloseSide = orderType === 'buy' ? 'buy' : 'sell';

            let pPrice = 0, sPrice = 0, pOrder = 'skipped', sOrder = 'skipped';
            let closeCommission = 0;

            const pOpen = parseFloat(trade.primary_open_price as any);
            const sOpen = parseFloat(trade.secondary_open_price as any);

            const amount = parseFloat(trade.amount as any);

            if (isReal) {
                // Before closing, fetch current exchange positions and close the
                // actual position sizes. This handles partial fills and cleanup
                // residue more accurately than blindly using the original amount.
                const info = this.marketInfo.getInfo(symbol);
                const minQty = info?.minQty || 0;
                
                let pSize = amount; let sSize = amount;
                
                if (this.bot.trade_on_primary_exchange) {
                    const pPositions = await (this.primaryClient as any).ccxtInstance.fetchPositions([symbol]);
                    const pPos = pPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
                    pSize = pPos ? Math.abs(Number(pPos.contracts ?? pPos.amount ?? 0)) : 0;
                }
                
                if (this.bot.trade_on_secondary_exchange) {
                    const sPositions = await (this.secondaryClient as any).ccxtInstance.fetchPositions([symbol]);
                    const sPos = sPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
                    sSize = sPos ? Math.abs(Number(sPos.contracts ?? sPos.amount ?? 0)) : 0;
                }

                const closePromises = [];

                if (this.bot.trade_on_primary_exchange && pSize >= minQty) {
                    // reduceOnly avoids accidentally flipping direction if the
                    // exchange position changed between fetch and order submit.
                    closePromises.push(this.primaryClient.createMarketOrder(symbol, primaryCloseSide, pSize, { reduceOnly: true }).then(r => {
                        pPrice = r.avgPrice; pOrder = r.orderId; closeCommission += r.commission;
                    }));
                } else {
                    // If the leg was disabled or too small to close, use current
                    // orderbook price or fall back to the open price for reporting.
                    pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
                }

                if (this.bot.trade_on_secondary_exchange && sSize >= minQty) {
                    closePromises.push(this.secondaryClient.createMarketOrder(symbol, secondaryCloseSide, sSize, { reduceOnly: true }).then(r => {
                        sPrice = r.avgPrice; sOrder = r.orderId; closeCommission += r.commission;
                    }));
                } else {
                    sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
                }

                await Promise.all(closePromises);
                
                if (pPrice === 0 && this.bot.trade_on_primary_exchange) pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
                if (sPrice === 0 && this.bot.trade_on_secondary_exchange) sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);

            } else {
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }

            const openCommission = parseFloat(trade.open_commission as any) || 0;
            const totalCommission = openCommission + closeCommission;
            
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
               // Django does not have a "liquidation" close_reason choice, so the
               // engine records it as error while retaining force_closed status.
               payload.close_reason = reason === 'liquidation' ? 'error' : reason;
               payload.primary_close_order_id = pOrder;
               payload.secondary_close_order_id = sOrder;
               payload.close_commission = d(closeCommission, 6);
               payload.profit_usdt = d(profitUsdt, 6);
            }

            logger.info(this.tag, `📝 Close Payload Details:\n${JSON.stringify(payload, null, 2)}`);

            if (isReal) await api.closeTrade(trade.id, payload);
            else await api.closeEmulationTrade(trade.id, payload);

            this.state.activeTrade = null;
            this.state.openedAtMs = null;

            logger.info(this.tag, `✅ Closed (${reason}). PnL: ${profitPercentage.toFixed(3)}%`);

        } catch (e: any) {
            logger.error(this.tag, `❌ Error closing: ${e.message}`);
        } finally {
            this.state.busy = false;
        }
    }

    private calculateCloseSpread(primaryPrice: number, secondaryPrice: number, orderType: 'buy' | 'sell'): number {
        // Close spread is the reverse of the entry direction. The formula mirrors
        // how calculateOpenSpread chooses bid/ask relationships for each side.
        if (orderType === 'buy') return ((primaryPrice - secondaryPrice) / secondaryPrice) * 100;
        else return ((secondaryPrice - primaryPrice) / primaryPrice) * 100;
    }

    private async checkTimeouts() {
        // Timeouts are a hard risk control. They do not require profit conditions
        // and use emergency prices so stale/partial depth does not block exit.
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

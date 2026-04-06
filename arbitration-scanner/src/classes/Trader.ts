import { type Exchange } from 'ccxt';
import { calculateOpenSpread, calculateTruePnL, type OrderbookPrices } from '../utils/math.js';
import { api } from '../services/api.js';

const TRADE_AMOUNT = 10; // $10 position
const OPEN_THRESHOLD = 2.0; // 2% absolute growth over baseline
const CLOSE_THRESHOLD = 1.5; // 1.5% True PnL profit
// Bybit only accepts [1, 50, 200, 1000] for swap orderbook depth
const ORDERBOOK_LIMIT = 50;

/** Round a number to fit Django DecimalField constraints */
function d(value: number, decimals: number = 8): number {
    return parseFloat(value.toFixed(decimals));
}

interface PairState {
    baselineBuy: number | null;
    baselineSell: number | null;
    activeTrade: any | null;
    /** Mutex: prevents concurrent open/close race conditions */
    busy: boolean;
}

export class Trader {
    private isRunning = true;
    private states: Map<string, PairState> = new Map();

    constructor(
        public id: number,
        public symbols: string[],
        private binance: Exchange,
        private bybit: Exchange,
    ) {
        for (const sym of symbols) {
            this.states.set(sym, {
                baselineBuy: null,
                baselineSell: null,
                activeTrade: null,
                busy: false,
            });
        }
    }

    /**
     * Restore open trades from Django API after a restart.
     */
    public async restoreOpenTrades(openTrades: any[]) {
        for (const trade of openTrades) {
            const sym = trade.coin;
            const state = this.states.get(sym);
            if (state && !state.activeTrade) {
                state.activeTrade = trade;
                console.log(`[Trader ${this.id}] ♻️ Restored open trade ${sym} (ID: ${trade.id}, ${trade.order_type})`);
            }
        }
    }

    /**
     * Start watching orderbooks. Returns a Promise that never resolves
     * (keeps running until `stop()` is called).
     */
    public async start(): Promise<void> {
        console.log(`[Trader ${this.id}] Starting loops for ${this.symbols.length} pairs...`);

        const loops: Promise<void>[] = [];
        for (const symbol of this.symbols) {
            loops.push(this.watchLoop(this.binance, symbol, 'Binance'));
            loops.push(this.watchLoop(this.bybit, symbol, 'Bybit'));
        }

        await Promise.all(loops);
    }

    public stop() {
        this.isRunning = false;
        console.log(`[Trader ${this.id}] Stopped.`);
    }

    // ───────────── Private ─────────────

    private async watchLoop(exchange: Exchange, symbol: string, exName: string) {
        let consecutiveErrors = 0;

        while (this.isRunning) {
            try {
                await exchange.watchOrderBook(symbol, ORDERBOOK_LIMIT);
                consecutiveErrors = 0;
                await this.checkSpreads(symbol);
            } catch (e: any) {
                consecutiveErrors++;
                const delay = Math.min(2000 * consecutiveErrors, 30000);
                console.error(`[Trader ${this.id}] WS error ${exName} ${symbol} (attempt ${consecutiveErrors}): ${e.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    private getPrices(symbol: string): OrderbookPrices | null {
        const bOb = this.binance.orderbooks?.[symbol];
        const yOb = this.bybit.orderbooks?.[symbol];

        if (
            !bOb || !yOb ||
            !bOb.bids?.length || !bOb.asks?.length ||
            !yOb.bids?.length || !yOb.asks?.length
        ) {
            return null;
        }

        return {
            primaryBid: bOb.bids[0][0],
            primaryAsk: bOb.asks[0][0],
            secondaryBid: yOb.bids[0][0],
            secondaryAsk: yOb.asks[0][0],
        };
    }

    private async checkSpreads(symbol: string) {
        const prices = this.getPrices(symbol);
        if (!prices) return;

        const state = this.states.get(symbol)!;
        if (state.busy) return;

        const currentBuySpread = calculateOpenSpread(prices, 'buy');
        const currentSellSpread = calculateOpenSpread(prices, 'sell');

        // ==== 1. BASELINE INITIALIZATION ====
        if (state.baselineBuy === null) state.baselineBuy = currentBuySpread;
        if (state.baselineSell === null) state.baselineSell = currentSellSpread;

        // ==== 2. IN TRADE: monitor PnL for exit ====
        if (state.activeTrade) {
            await this.checkExit(symbol, state, prices, currentBuySpread, currentSellSpread);
            return;
        }

        // ==== 3. IDLE: look for entry ====
        if (currentBuySpread >= state.baselineBuy + OPEN_THRESHOLD) {
            await this.executeOpen(symbol, state, 'buy', prices, currentBuySpread);
            return;
        }
        if (currentSellSpread >= state.baselineSell + OPEN_THRESHOLD) {
            await this.executeOpen(symbol, state, 'sell', prices, currentSellSpread);
            return;
        }
    }

    private async checkExit(
        symbol: string,
        state: PairState,
        prices: OrderbookPrices,
        currentBuySpread: number,
        currentSellSpread: number,
    ) {
        const trade = state.activeTrade;
        const pOpen = parseFloat(trade.primary_open_price);
        const sOpen = parseFloat(trade.secondary_open_price);
        const orderType = trade.order_type as 'buy' | 'sell';

        const currentPnL = calculateTruePnL({ pOpen, sOpen }, prices, orderType);

        if (currentPnL < CLOSE_THRESHOLD) return;

        state.busy = true;
        console.log(`[Trader ${this.id}] 🟢 CLOSING ${symbol} (${orderType}), PnL: +${currentPnL.toFixed(3)}%`);

        try {
            const pClose = orderType === 'buy' ? prices.primaryBid : prices.primaryAsk;
            const sClose = orderType === 'buy' ? prices.secondaryAsk : prices.secondaryBid;
            const closeSpread = orderType === 'buy'
                ? ((prices.secondaryAsk - prices.primaryBid) / prices.primaryBid * 100)
                : ((prices.primaryAsk - prices.secondaryBid) / prices.secondaryBid * 100);

            await api.closeTrade(trade.id, {
                status: 'closed',
                primary_close_price: d(pClose),
                secondary_close_price: d(sClose),
                close_spread: d(closeSpread, 4),
                profit_percentage: d(currentPnL, 4),
                closed_at: new Date().toISOString(),
            });

            state.activeTrade = null;
            state.baselineBuy = currentBuySpread;
            state.baselineSell = currentSellSpread;
            console.log(`[Trader ${this.id}] ✅ Closed ${symbol}. New baseline set.`);
        } catch (e: any) {
            console.error(`[Trader ${this.id}] ❌ Error closing ${symbol}:`, e.message);
        } finally {
            state.busy = false;
        }
    }

    private async executeOpen(
        symbol: string,
        state: PairState,
        orderType: 'buy' | 'sell',
        prices: OrderbookPrices,
        spread: number,
    ) {
        state.busy = true;
        console.log(`[Trader ${this.id}] 🔴 OPENING ${symbol} (${orderType}) at Spread ${spread.toFixed(3)}%`);

        const pOpen = orderType === 'buy' ? prices.primaryAsk : prices.primaryBid;
        const sOpen = orderType === 'buy' ? prices.secondaryBid : prices.secondaryAsk;
        const coinPrice = orderType === 'buy' ? prices.primaryAsk : prices.secondaryAsk;
        const amount = TRADE_AMOUNT / coinPrice;

        try {
            state.activeTrade = await api.openTrade({
                coin: symbol,
                primary_exchange: 'binance_futures',
                secondary_exchange: 'bybit_futures',
                order_type: orderType,
                status: 'open',
                amount: d(amount),
                primary_open_price: d(pOpen),
                secondary_open_price: d(sOpen),
                open_spread: d(spread, 4),
            });
            console.log(`[Trader ${this.id}] ✅ Opened ${symbol}. DB ID: ${state.activeTrade.id}`);
        } catch (e: any) {
            console.error(`[Trader ${this.id}] ❌ Failed to open ${symbol}:`, e.message);
            state.baselineBuy = calculateOpenSpread(prices, 'buy');
            state.baselineSell = calculateOpenSpread(prices, 'sell');
        } finally {
            state.busy = false;
        }
    }
}

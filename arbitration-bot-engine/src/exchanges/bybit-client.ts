import * as ccxt from 'ccxt';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BybitClient';

/**
 * Bybit USDT perpetual REST adapter built on ccxt.
 *
 * Unlike Binance/Gate, Bybit can use ccxt directly for market loading, order
 * placement and position queries. The adapter still normalizes results into the
 * engine-wide OrderResult shape.
 */
export class BybitClient implements IExchangeClient {
    public readonly name = 'Bybit';
    private exchange: ccxt.bybit;

    constructor(apiKey: string, secret: string) {
        // defaultType=swap makes ccxt target perpetual contracts rather than spot.
        this.exchange = new ccxt.bybit({
            apiKey,
            secret,
            enableRateLimit: true,
            ...(config.useTestnet && {
                sandbox: true,
            }),
            options: {
                defaultType: 'swap',
            },
        });
    }

    /** Expose the underlying ccxt instance for WebSocket subscriptions */
    get ccxtInstance(): ccxt.bybit {
        return this.exchange;
    }

    async loadMarkets(): Promise<void> {
        // ccxt stores loaded market metadata on exchange.markets.
        await this.exchange.loadMarkets();
        logger.info(TAG, `Markets loaded: ${Object.keys(this.exchange.markets).length} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        try {
            await this.exchange.setLeverage(leverage, symbol);
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
        } catch (e: any) {
            // Bybit may throw if leverage is already at the target value
            if (e.message?.includes('leverage not modified') || e.message?.includes('110043')) {
                logger.debug(TAG, `Leverage already ${leverage}x for ${symbol}`);
            } else {
                throw new Error(`Failed to set leverage to ${leverage}x on Bybit: ${e.message}`);
            }
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        try {
            await this.exchange.setMarginMode('isolated', symbol);
            logger.debug(TAG, `Isolated margin set for ${symbol}`);
        } catch (e: any) {
            // Bybit Unified Trading Accounts (UTA) do not support per-symbol
            // margin mode; the API returns codes 110026/110027/110028/3400045
            // or text including "isolated", "not modified", or "unified account".
            // For those cases the call is a no-op and must not abort engine start.
            const msg = e?.message || '';
            const benign = /isolated|110026|110027|110028|3400045|unified|not modified/i.test(msg);
            if (benign) {
                logger.debug(TAG, `Margin mode call skipped for ${symbol}: ${msg}`);
            } else {
                throw new Error(`Failed to set isolated margin on Bybit: ${msg}`);
            }
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: any = {},
    ): Promise<OrderResult> {
        logger.debug(TAG, `Creating ${side} order for ${symbol}, amount: ${amount}`);

        const order = await this.exchange.createMarketOrder(symbol, side, amount, undefined, params);
        let filled = order;

        // Fast single retry: Bybit usually returns the filled order immediately
        // but the average price field can be unset for the first tick after
        // execution. A short 150ms retry avoids blocking the hot path for
        // multiple seconds the way the previous 5×1000ms loop did.
        if ((!filled.average || filled.status !== 'closed') && order.id) {
            await new Promise(r => setTimeout(r, 150));
            try {
                const checked = await this.exchange.fetchOrder(order.id, symbol);
                if (checked) filled = checked;
            } catch (e) {
                // Ignore fetch errors during the quick retry.
            }
        }

        const result: OrderResult = {
            orderId: String(filled.id),
            avgPrice: filled.average ?? filled.price ?? 0,
            filledQty: filled.filled ?? amount,
            // Commission is backfilled asynchronously via fetchOrderCommission
            // to keep the latency-critical execution path short.
            commission: 0,
            commissionAsset: 'USDT',
            status: filled.status ?? 'unknown',
            raw: filled,
        };

        logger.info(TAG, `Order placed: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, id=${result.orderId}`);
        return result;
    }

    async fetchOrderCommission(symbol: string, orderId: string): Promise<number> {
        // Bybit may take a moment to attach fee details after fill; retry with
        // backoff up to ~3 seconds in total.
        const delays = [200, 400, 800, 1500];
        for (let i = 0; i < delays.length; i++) {
            try {
                const order = await this.exchange.fetchOrder(orderId, symbol);
                const commission = this.extractCommission(order);
                if (commission > 0 || order.status === 'closed') {
                    return commission;
                }
            } catch (e) {
                // continue retrying
            }
            await new Promise(r => setTimeout(r, delays[i]));
        }
        logger.warn(TAG, `Could not fetch commission for order ${orderId} after retries`);
        return 0;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        // ccxt exchanges can report amount precision either as decimal places or
        // as a tick size. Check precisionMode before deriving stepSize.
        const market = this.exchange.markets[symbol];
        if (!market) return null;

        let stepSize = 0.001;
        if (market.precision?.amount !== undefined) {
            const prec = Number(market.precision.amount);
            if (this.exchange.precisionMode === (ccxt as any).TICK_SIZE) {
                stepSize = prec;
            } else {
                stepSize = Math.pow(10, -prec);
            }
        }

        return {
            symbol,
            minQty: market.limits?.amount?.min ?? 0,
            stepSize,
            minNotional: market.limits?.cost?.min ?? 0,
            pricePrecision: (market.precision?.price as number) ?? 8,
            quantityPrecision: (market.precision?.amount as number) ?? 8,
        };
    }

    getUsdtSymbols(): string[] {
        // ccxt futures symbols usually end with :USDT, e.g. BTC/USDT:USDT.
        return Object.keys(this.exchange.markets).filter(sym => sym.endsWith(':USDT'));
    }

    private extractCommission(order: any): number {
        // Normalize fee objects into an approximate USDT value. If the exchange
        // charges non-USDT fees, this fallback multiplies by the order price.
        if (order.fees && Array.isArray(order.fees)) {
            return order.fees.reduce((total: number, fee: any) => {
                if (fee.currency === 'USDT') {
                    return total + (fee.cost ?? 0);
                }
                return total + (fee.cost ?? 0) * (order.average ?? order.price ?? 0);
            }, 0);
        }
        if (order.fee) {
            const fee = order.fee;
            if (fee.currency === 'USDT') {
                return fee.cost ?? 0;
            }
            return (fee.cost ?? 0) * (order.average ?? order.price ?? 0);
        }
        return 0;
    }
}

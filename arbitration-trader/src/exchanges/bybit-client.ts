import * as ccxt from 'ccxt';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BybitClient';

export class BybitClient implements IExchangeClient {
    public readonly name = 'Bybit';
    private exchange: ccxt.bybit;

    constructor() {
        this.exchange = new ccxt.bybit({
            apiKey: config.bybit.apiKey,
            secret: config.bybit.secret,
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
            // Bybit may throw if margin mode is already isolated
            if (e.message?.includes('isolated') || e.message?.includes('110026')) {
                logger.debug(TAG, `Margin already isolated for ${symbol}`);
            } else {
                throw new Error(`Failed to set isolated margin on Bybit: ${e.message}`);
            }
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: any = {},
    ): Promise<OrderResult> {
        logger.info(TAG, `Creating ${side} order for ${symbol}, amount: ${amount}`);

        const order = await this.exchange.createMarketOrder(symbol, side, amount, undefined, params);
        let filled = order;

        // DB Lag fallback: give exchange matching engine 500ms to calculate fills before fetching
        if (!filled.average || filled.status !== 'closed') {
            await new Promise(r => setTimeout(r, 500));
            try {
                filled = await this.exchange.fetchOrder(order.id, symbol);
            } catch (e) {
                // Fallback to raw order if fetchOrder throws
                filled = order;
            }
        }

        const commission = this.extractCommission(filled);

        const result: OrderResult = {
            orderId: String(filled.id),
            avgPrice: filled.average ?? filled.price ?? 0,
            filledQty: filled.filled ?? amount,
            commission,
            commissionAsset: 'USDT',
            status: filled.status ?? 'unknown',
            raw: filled,
        };

        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.exchange.markets[symbol];
        if (!market) return null;

        let stepSize = 0.001;
        if (market.precision?.amount !== undefined) {
            const prec = Number(market.precision.amount);
            if (this.exchange.precisionMode === ccxt.TICK_SIZE) {
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
        return Object.keys(this.exchange.markets).filter(sym => sym.endsWith(':USDT'));
    }

    private extractCommission(order: any): number {
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

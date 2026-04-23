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

        // DB Lag fallback: Bybit API sometimes requires over 500ms to calculate fills
        let retries = 0;
        while ((!filled.average || filled.status !== 'closed') && retries < 5) {
            await new Promise(r => setTimeout(r, 1000)); // 1000ms * 5 = up to 5s buffer
            retries++;
            try {
                const checked = await this.exchange.fetchOrder(order.id, symbol);
                if (checked) filled = checked;
                
                // If the exchange finally returned a valid price, we can stop waiting
                if (filled.average && filled.status === 'closed') {
                    break;
                }
            } catch (e) {
                // If fetch drops, ignore and keep trying until timeout
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

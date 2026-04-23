import * as ccxt from 'ccxt';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'MexcClient';

/**
 * MEXC futures REST adapter built on ccxt.
 *
 * MEXC behavior is less uniform than Binance/Bybit for margin setup and filled
 * order details, so this adapter favors best-effort setup and post-order polling
 * instead of failing early on non-critical account-configuration responses.
 */
export class MexcClient implements IExchangeClient {
    public readonly name = 'Mexc';
    private exchange: ccxt.mexc;

    constructor(apiKey: string, secret: string) {
        // defaultType=swap tells ccxt to use futures/swap endpoints.
        this.exchange = new ccxt.mexc({
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

    get ccxtInstance(): ccxt.mexc {
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
            // Current engine setup treats MEXC leverage setup failures as warnings
            // so the bot can still run in monitoring/emulation scenarios.
            logger.warn(TAG, `Failed to set leverage to ${leverage}x on MEXC for ${symbol}: ${e.message}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        try {
            await this.exchange.setMarginMode('isolated', symbol);
            logger.debug(TAG, `Isolated margin set for ${symbol}`);
        } catch (e: any) {
            if (e.message?.includes('already in isolated')) {
                logger.debug(TAG, `Margin already isolated for ${symbol}`);
            } else {
                logger.warn(TAG, `Failed to set isolated margin on MEXC: ${e.message}. Trying direct explicit API fallback...`);
                try {
                    // Try the implicit ccxt endpoint when the unified method is
                    // unsupported or returns an exchange-specific error.
                    const market = this.exchange.market(symbol);
                    if (market?.id) {
                        await (this.exchange as any).contractPrivatePostApiV1MarginIsolated({
                            symbol: market.id,
                            type: 1 // MEXC commonly uses 1 for isolated margin.
                        });
                        logger.debug(TAG, `Isolated margin set for ${symbol} via fallback api.`);
                    }
                } catch (fallbackE: any) {
                    logger.error(TAG, `Fallback failed: ${fallbackE.message}`);
                }
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

        // Poll for execution details because MEXC can initially return an order
        // object with missing average price or open status immediately after fill.
        let retries = 0;
        while ((!filled.average || filled.status !== 'closed') && retries < 5) {
            await new Promise(r => setTimeout(r, 1000));
            retries++;
            try {
                const checked = await this.exchange.fetchOrder(order.id, symbol);
                if (checked && checked.average) filled = checked;
                if (filled.average && filled.status === 'closed') break;
            } catch (e) {
                // Ignore fetch errors during polling
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

        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, prev commission: ${result.commission}`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        // Convert ccxt precision/limit metadata into the common market-info shape.
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

        let priceStep = 0.001;
        if (market.precision?.price !== undefined) {
            const prec = Number(market.precision.price);
            if (this.exchange.precisionMode === (ccxt as any).TICK_SIZE) {
                priceStep = prec;
            } else {
                priceStep = Math.pow(10, -prec);
            }
        }

        return {
            symbol,
            minQty: market.limits?.amount?.min ?? 0,
            stepSize,
            minNotional: market.limits?.cost?.min ?? 0,
            pricePrecision: Math.max(0, Math.round(-Math.log10(priceStep))),
            quantityPrecision: Math.max(0, Math.round(-Math.log10(stepSize))),
        };
    }

    getUsdtSymbols(): string[] {
        // Keep only USDT-settled perpetual symbols.
        return Object.keys(this.exchange.markets).filter(sym => sym.endsWith(':USDT'));
    }

    private extractCommission(order: any): number {
        // MEXC may report zero-fee promotions or fees in assets that are hard to
        // convert safely here. Only quote-stable fees are added to reported cost.
        if (order.fees && Array.isArray(order.fees)) {
            return order.fees.reduce((total: number, fee: any) => {
                if (['USDT', 'USDC'].includes(fee.currency)) return total + (fee.cost ?? 0);
                return total; // Safely default to 0 if 0% taker fee or unknown token
            }, 0);
        }
        if (order.fee) {
            const fee = order.fee;
            if (['USDT', 'USDC'].includes(fee.currency)) return fee.cost ?? 0;
            return 0;
        }
        return 0;
    }
}

import { createHmac } from 'node:crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import type { ExchangePosition, ExchangeTicker, MarketWsClient } from './market-ws.js';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import { BinanceMarketWs } from './binance-market-ws.js';
import { binanceToUnified, unifiedToBinance } from './symbols.js';
import { buildQuery, requestJson, sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BinanceClient';
const REQUEST_TIMEOUT_MS = 10_000;
const COMMISSION_DELAYS_MS = [200, 400, 800, 1500];
const FAST_RETRY_MS = 100;

interface BinanceMarketRaw {
    symbol: string;
    contractType?: string;
    quoteAsset?: string;
    filters?: Array<Record<string, string>>;
}

interface BinanceOrderResponse {
    orderId: number | string;
    status?: string;
    avgPrice?: string;
    price?: string;
    executedQty?: string;
}

interface BinancePositionRisk {
    symbol?: string;
    positionAmt?: string;
    entryPrice?: string;
}

interface BinanceUserTrade {
    price?: string;
    qty?: string;
    commission?: string;
    commissionAsset?: string;
}

interface BinanceTickerRaw {
    lastPrice?: string;
    quoteVolume?: string;
    price?: string;
}

/**
 * Binance USDT-M futures native REST adapter.
 *
 * The client speaks the Binance API directly so the engine never depends on
 * ccxt. Signing is done via HMAC-SHA256 over the sorted query string; the API
 * key travels in `X-MBX-APIKEY` and the secret never leaves this module.
 */
export class BinanceClient implements IExchangeClient {
    readonly name = 'Binance';
    readonly exchangeKey = 'binance';

    private readonly baseUrl: string;
    private readonly markets = new Map<string, BinanceMarketRaw>();

    constructor(private readonly apiKey: string, private readonly secret: string) {
        this.baseUrl = config.useTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';
    }

    async loadMarkets(): Promise<void> {
        const info = await this.publicRequest<{ symbols?: BinanceMarketRaw[] }>(
            'GET',
            '/fapi/v1/exchangeInfo',
        );
        this.markets.clear();
        for (const sym of info.symbols ?? []) {
            if (sym.contractType === 'PERPETUAL' && sym.quoteAsset === 'USDT') {
                this.markets.set(sym.symbol, sym);
            }
        }
        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        try {
            await this.signedRequest('POST', '/fapi/v1/leverage', {
                symbol: unifiedToBinance(symbol),
                leverage: String(leverage),
            });
        } catch (e: unknown) {
            const message = errorMessage(e);
            // Binance returns "No need to change" when leverage already matches —
            // treat it as success so engine startup stays idempotent.
            if (message.includes('No need to change')) return;
            throw new Error(`Failed to set leverage to ${leverage}x on Binance: ${message}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        try {
            await this.signedRequest('POST', '/fapi/v1/marginType', {
                symbol: unifiedToBinance(symbol),
                marginType: 'ISOLATED',
            });
        } catch (e: unknown) {
            const message = errorMessage(e);
            if (message.includes('No need to change')) return;
            throw new Error(`Failed to set isolated margin on Binance: ${message}`);
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean } = {},
    ): Promise<OrderResult> {
        const exchangeSymbol = unifiedToBinance(symbol);
        const quantity = formatQuantity(amount);
        const orderParams: Record<string, string> = {
            symbol: exchangeSymbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity,
            // newOrderRespType=RESULT makes Binance compute avgPrice / executedQty
            // synchronously before responding, eliminating a follow-up poll in
            // the common case.
            newOrderRespType: 'RESULT',
        };
        if (params.reduceOnly) orderParams.reduceOnly = 'true';

        let order = await this.signedRequest<BinanceOrderResponse>('POST', '/fapi/v1/order', orderParams);
        let avgPrice = Number(order.avgPrice ?? order.price ?? 0);

        // Single fast retry covers the rare matching-engine lag where the POST
        // returns before avgPrice is populated. 100ms keeps hot-path overhead
        // negligible while still capturing the fill almost always.
        if (avgPrice === 0 || !isTerminalStatus(order.status)) {
            await sleep(FAST_RETRY_MS);
            try {
                const checked = await this.signedRequest<BinanceOrderResponse>('GET', '/fapi/v1/order', {
                    symbol: exchangeSymbol,
                    orderId: String(order.orderId),
                });
                order = checked;
                avgPrice = Number(checked.avgPrice ?? 0);
            } catch {
                // Ignore: the original order response is still usable.
            }
        }

        const result: OrderResult = {
            orderId: String(order.orderId),
            avgPrice,
            filledQty: Number(order.executedQty ?? amount) || amount,
            commission: 0,
            commissionAsset: 'USDT',
            status: order.status === 'FILLED' ? 'closed' : (order.status?.toLowerCase() ?? 'unknown'),
            raw: order,
        };
        logger.info(TAG, `Order placed: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, id=${result.orderId}`);
        return result;
    }

    async fetchOrderCommission(symbol: string, orderId: string): Promise<number> {
        const exchangeSymbol = unifiedToBinance(symbol);
        for (let i = 0; i < COMMISSION_DELAYS_MS.length; i++) {
            try {
                const trades = await this.signedRequest<BinanceUserTrade[]>('GET', '/fapi/v1/userTrades', {
                    symbol: exchangeSymbol,
                    orderId,
                });
                if (Array.isArray(trades) && trades.length > 0) {
                    let commission = 0;
                    for (const trade of trades) {
                        const fee = Number(trade.commission ?? 0);
                        if (trade.commissionAsset === 'BNB') {
                            // Approximate BNB-fee USDT equivalent without an extra
                            // price call. Real users with significant BNB-fee
                            // volume should prefer USDT fee settings; this estimate
                            // keeps Django totals close enough for PnL accounting.
                            const notional = Number(trade.price ?? 0) * Number(trade.qty ?? 0);
                            commission += notional * 0.00045;
                        } else {
                            commission += Math.abs(fee);
                        }
                    }
                    return commission;
                }
            } catch {
                // Retry until the user-trades feed catches up.
            }
            await sleep(COMMISSION_DELAYS_MS[i]);
        }
        logger.warn(TAG, `Could not fetch commission for order ${orderId} after retries`);
        return 0;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.markets.get(unifiedToBinance(symbol));
        if (!market) return null;
        let tickSize = 0.001;
        let stepSize = 0.001;
        let minQty = 0;
        let minNotional = 0;
        for (const filter of market.filters ?? []) {
            if (filter.filterType === 'PRICE_FILTER') tickSize = Number(filter.tickSize);
            if (filter.filterType === 'LOT_SIZE') {
                stepSize = Number(filter.stepSize);
                minQty = Number(filter.minQty);
            }
            if (filter.filterType === 'MIN_NOTIONAL') {
                minNotional = Number(filter.notional ?? filter.minNotional);
            }
        }
        return {
            symbol,
            minQty,
            stepSize,
            minNotional,
            pricePrecision: Math.max(0, Math.round(-Math.log10(tickSize))),
            quantityPrecision: Math.max(0, Math.round(-Math.log10(stepSize))),
        };
    }

    getUsdtSymbols(): string[] {
        return [...this.markets.keys()].map(binanceToUnified);
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const result: ExchangePosition[] = [];
        await Promise.all(symbols.map(async symbol => {
            const exchangeSymbol = unifiedToBinance(symbol);
            try {
                const positions = await this.signedRequest<BinancePositionRisk[]>(
                    'GET',
                    '/fapi/v2/positionRisk',
                    { symbol: exchangeSymbol },
                );
                if (!Array.isArray(positions)) return;
                for (const position of positions) {
                    const amount = Number(position.positionAmt ?? 0);
                    if (!Number.isFinite(amount) || amount === 0) continue;
                    result.push({
                        symbol,
                        side: amount > 0 ? 'long' : 'short',
                        size: Math.abs(amount),
                        entryPrice: Number(position.entryPrice ?? 0),
                    });
                }
            } catch (e: unknown) {
                logger.error(TAG, `Failed to fetch positions for ${symbol}: ${errorMessage(e)}`);
            }
        }));
        return result;
    }

    async fetchTicker(symbol: string): Promise<ExchangeTicker> {
        const exchangeSymbol = unifiedToBinance(symbol);
        const data = await this.publicRequest<BinanceTickerRaw>(
            'GET',
            '/fapi/v1/ticker/24hr',
            { symbol: exchangeSymbol },
        );
        return {
            last: Number(data.lastPrice ?? data.price ?? 0),
            quoteVolume: Number(data.quoteVolume ?? 0),
        };
    }

    createMarketWs(store: OrderBookStore): MarketWsClient {
        return new BinanceMarketWs(store, config.useTestnet);
    }

    private async publicRequest<T>(
        method: 'GET' | 'POST',
        path: string,
        params: Record<string, string | number> = {},
    ): Promise<T> {
        const query = buildQuery(params);
        const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
        return requestJson<T>(url, { method, timeoutMs: REQUEST_TIMEOUT_MS });
    }

    private async signedRequest<T>(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        params: Record<string, string | number>,
    ): Promise<T> {
        if (!this.apiKey || !this.secret) {
            throw new Error('Binance API credentials are required.');
        }
        const signed = { ...params, timestamp: Date.now(), recvWindow: 5000 };
        const query = buildQuery(signed);
        const signature = createHmac('sha256', this.secret).update(query).digest('hex');
        const queryWithSig = `${query}&signature=${signature}`;
        const headers: Record<string, string> = { 'X-MBX-APIKEY': this.apiKey };

        let url = `${this.baseUrl}${path}`;
        let body: string | undefined;
        if (method === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = queryWithSig;
        } else {
            url = `${url}?${queryWithSig}`;
        }

        try {
            return await requestJson<T>(url, { method, headers, body, timeoutMs: REQUEST_TIMEOUT_MS });
        } catch (e: unknown) {
            // Surface Binance error envelopes as a flat message so callers can
            // log/normalise without parsing nested JSON.
            throw new Error(`Binance API Error: ${errorMessage(e)}`);
        }
    }
}

function isTerminalStatus(status: string | undefined): boolean {
    return status === 'FILLED'
        || status === 'PARTIALLY_FILLED'
        || status === 'EXPIRED'
        || status === 'REJECTED'
        || status === 'CANCELED';
}

function formatQuantity(value: number): string {
    return Number(value).toFixed(10).replace(/\.?0+$/, '');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

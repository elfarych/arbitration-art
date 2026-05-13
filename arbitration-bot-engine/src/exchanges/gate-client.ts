import { createHash, createHmac } from 'node:crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import type { ExchangePosition, ExchangeTicker, MarketWsClient } from './market-ws.js';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import { GateMarketWs } from './gate-market-ws.js';
import { underscoredToUnified, unifiedToUnderscored } from './symbols.js';
import { buildQuery, requestJson, sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'GateClient';
const REQUEST_TIMEOUT_MS = 10_000;
const FAST_RETRY_MS = 150;
const COMMISSION_DELAYS_MS = [200, 400, 800, 1500];

interface GateContractRaw {
    name?: string;
    type?: string;
    quanto_multiplier?: string;
    order_price_round?: string;
    order_size_min?: string;
    order_size_round?: string;
    in_delisting?: boolean;
}

interface GateOrderRaw {
    id?: string | number;
    status?: string;
    fill_price?: string;
    size?: number;
    left?: number;
}

interface GatePositionRaw {
    contract?: string;
    size?: number;
    entry_price?: string;
}

interface GateTickerRaw {
    contract?: string;
    last?: string;
    volume_24h_quote?: string;
}

interface GateMyTradeRaw {
    fee?: string;
}

/**
 * Gate.io USDT-futures native REST adapter.
 *
 * Gate signs requests with HMAC-SHA512 over `METHOD\n/api/v4/path\nQUERY\n
 * SHA512(BODY)\nTIMESTAMP`. Trade amounts are expressed in base-coin units in
 * the engine; this adapter converts to/from Gate contract counts via the
 * cached `quanto_multiplier`.
 */
export class GateClient implements IExchangeClient {
    readonly name = 'Gate';
    readonly exchangeKey = 'gate';

    private readonly baseUrl: string;
    private readonly markets = new Map<string, GateContractRaw>();

    constructor(private readonly apiKey: string, private readonly secret: string) {
        this.baseUrl = config.useTestnet
            ? 'https://fx-api-testnet.gateio.ws/api/v4'
            : 'https://api.gateio.ws/api/v4';
    }

    async loadMarkets(): Promise<void> {
        const contracts = await this.publicRequest<GateContractRaw[]>('GET', '/futures/usdt/contracts');
        this.markets.clear();
        for (const contract of contracts) {
            if (contract.name && !contract.in_delisting) {
                this.markets.set(contract.name, contract);
            }
        }
        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        try {
            // Gate v4 expects exactly one non-zero leverage value: `leverage`
            // configures isolated; `cross_leverage_limit` configures cross.
            // Sending `cross_leverage_limit=0` is mandatory to keep the position
            // in isolated mode; passing both non-zero either errors or silently
            // switches the position to cross.
            await this.privateRequest('POST', `/futures/usdt/positions/${exchangeSymbol}/leverage`, {
                leverage: String(leverage),
                cross_leverage_limit: '0',
            });
        } catch (e: unknown) {
            logger.warn(TAG, `Failed to set leverage to ${leverage}x on Gate for ${symbol}: ${errorMessage(e)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        try {
            // Gate keeps positions in isolated mode by default; calling the
            // margin endpoint with `size=0` is a documented no-op that
            // confirms the mode without changing position size.
            await this.privateRequest('POST', `/futures/usdt/positions/${exchangeSymbol}/margin`, { size: '0' });
        } catch (e: unknown) {
            logger.debug(TAG, `Gate isolated margin call skipped for ${symbol}: ${errorMessage(e)}`);
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean } = {},
    ): Promise<OrderResult> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        const market = this.markets.get(exchangeSymbol);
        if (!market) throw new Error(`Gate market not loaded for ${symbol}`);

        const multiplier = Number(market.quanto_multiplier ?? 1) || 1;
        let sizeInContracts = Math.round(amount / multiplier);
        if (side === 'sell') sizeInContracts = -sizeInContracts;

        const body: Record<string, unknown> = {
            contract: exchangeSymbol,
            size: sizeInContracts,
            price: '0',
            tif: 'ioc',
        };
        if (params.reduceOnly) body.reduce_only = true;

        const created = await this.privateRequest<GateOrderRaw>('POST', '/futures/usdt/orders', body, { jsonBody: true });
        let order = created;

        // Fast retry covers the case where Gate accepts the IOC market order
        // but has not yet stamped `fill_price`/`status=finished` before
        // responding. 150ms keeps hot-path overhead negligible.
        if ((!order.fill_price || order.fill_price === '0' || order.status === 'open') && order.id !== undefined) {
            await sleep(FAST_RETRY_MS);
            try {
                order = await this.privateRequest<GateOrderRaw>('GET', `/futures/usdt/orders/${order.id}`, {});
            } catch {
                // Use the initial response if the follow-up fetch fails.
            }
        }

        const filledContracts = Math.abs(Number(order.size ?? sizeInContracts)) - Math.abs(Number(order.left ?? 0));
        const filledQty = filledContracts * multiplier;
        const avgPrice = Number(order.fill_price ?? 0);

        const result: OrderResult = {
            orderId: String(order.id ?? ''),
            avgPrice,
            filledQty,
            commission: 0,
            commissionAsset: 'USDT',
            status: order.status === 'finished' ? 'closed' : (order.status ?? 'unknown'),
            raw: order,
        };
        logger.info(TAG, `Order placed: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, id=${result.orderId}`);
        return result;
    }

    async fetchOrderCommission(symbol: string, orderId: string): Promise<number> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        for (let i = 0; i < COMMISSION_DELAYS_MS.length; i++) {
            try {
                const trades = await this.privateRequest<GateMyTradeRaw[]>(
                    'GET',
                    '/futures/usdt/my_trades',
                    { contract: exchangeSymbol, order: orderId },
                );
                if (Array.isArray(trades) && trades.length > 0) {
                    let commission = 0;
                    for (const trade of trades) commission += Math.abs(Number(trade.fee ?? 0));
                    return commission;
                }
            } catch {
                // Retry until the fee feed catches up.
            }
            await sleep(COMMISSION_DELAYS_MS[i]);
        }
        logger.warn(TAG, `Could not fetch commission for order ${orderId} after retries`);
        return 0;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        const market = this.markets.get(exchangeSymbol);
        if (!market) return null;
        const multiplier = Number(market.quanto_multiplier ?? 1) || 1;
        const priceStep = Number(market.order_price_round ?? 0.001) || 0.001;
        const sizeStepContracts = Number(market.order_size_round ?? 1) || 1;
        const minQtyContracts = Number(market.order_size_min ?? 1) || 1;
        const stepSizeBase = sizeStepContracts * multiplier;
        const minQtyBase = minQtyContracts * multiplier;
        return {
            symbol,
            minQty: minQtyBase,
            stepSize: stepSizeBase,
            minNotional: 0,
            pricePrecision: priceStep > 0 ? Math.max(0, Math.round(-Math.log10(priceStep))) : 8,
            quantityPrecision: stepSizeBase > 0 ? Math.max(0, Math.round(-Math.log10(stepSizeBase))) : 8,
        };
    }

    getUsdtSymbols(): string[] {
        const out: string[] = [];
        for (const contract of this.markets.values()) {
            if (contract.type === 'direct' && contract.name?.endsWith('_USDT')) {
                out.push(underscoredToUnified(contract.name));
            }
        }
        return out;
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const result: ExchangePosition[] = [];
        await Promise.all(symbols.map(async symbol => {
            const exchangeSymbol = unifiedToUnderscored(symbol);
            try {
                const position = await this.privateRequest<GatePositionRaw>('GET', `/futures/usdt/positions/${exchangeSymbol}`, {});
                if (!position || position.size === undefined || Number(position.size) === 0) return;
                const market = this.markets.get(exchangeSymbol);
                const multiplier = Number(market?.quanto_multiplier ?? 1) || 1;
                const baseAmount = Math.abs(Number(position.size)) * multiplier;
                result.push({
                    symbol,
                    side: Number(position.size) > 0 ? 'long' : 'short',
                    size: baseAmount,
                    entryPrice: Number(position.entry_price ?? 0),
                });
            } catch (e: unknown) {
                logger.error(TAG, `Failed to fetch positions for ${symbol}: ${errorMessage(e)}`);
            }
        }));
        return result;
    }

    async fetchTicker(symbol: string): Promise<ExchangeTicker> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        const tickers = await this.publicRequest<GateTickerRaw[]>('GET', '/futures/usdt/tickers', { contract: exchangeSymbol });
        const ticker = Array.isArray(tickers) ? tickers[0] : (tickers as GateTickerRaw | undefined);
        return {
            last: Number(ticker?.last ?? 0),
            quoteVolume: Number(ticker?.volume_24h_quote ?? 0),
        };
    }

    createMarketWs(store: OrderBookStore): MarketWsClient {
        return new GateMarketWs(store, config.useTestnet);
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

    private async privateRequest<T>(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        params: Record<string, unknown>,
        options: { jsonBody?: boolean } = {},
    ): Promise<T> {
        if (!this.apiKey || !this.secret) {
            throw new Error('Gate API credentials are required.');
        }
        const compact = compactParams(params);
        const isBodyMethod = method === 'POST' || method === 'DELETE';
        const queryString = !isBodyMethod || !options.jsonBody
            ? buildSortedQuery(compact)
            : '';
        const bodyString = isBodyMethod && options.jsonBody
            ? JSON.stringify(compact)
            : '';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const fullPath = `/api/v4${path}`;
        const hashedBody = createHash('sha512').update(bodyString).digest('hex');
        const signPayload = `${method}\n${fullPath}\n${queryString}\n${hashedBody}\n${timestamp}`;
        const signature = createHmac('sha512', this.secret).update(signPayload).digest('hex');
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'KEY': this.apiKey,
            'Timestamp': timestamp,
            'SIGN': signature,
        };
        const url = queryString ? `${this.baseUrl}${path}?${queryString}` : `${this.baseUrl}${path}`;
        try {
            return await requestJson<T>(url, {
                method,
                headers,
                body: bodyString || undefined,
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
        } catch (e: unknown) {
            throw new Error(`Gate API Error: ${errorMessage(e)}`);
        }
    }
}

function compactParams<T extends Record<string, unknown>>(params: T): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = value as string | number | boolean;
    }
    return out;
}

function buildSortedQuery(params: Record<string, string | number | boolean>): string {
    const entries = Object.entries(params);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

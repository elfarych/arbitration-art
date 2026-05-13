import { createHmac } from 'node:crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import type { ExchangePosition, ExchangeTicker, MarketWsClient } from './market-ws.js';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import { MexcMarketWs } from './mexc-market-ws.js';
import { underscoredToUnified, unifiedToUnderscored } from './symbols.js';
import { requestJson, sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'MexcClient';
const REQUEST_TIMEOUT_MS = 10_000;
const FAST_RETRY_MS = 150;
const COMMISSION_DELAYS_MS = [200, 400, 800, 1500];

/**
 * MEXC contract REST envelope:
 * `{ success: boolean, code: number, data: T, message?: string }`.
 */
interface MexcResponse<T> {
    success?: boolean;
    code?: number;
    data?: T;
    message?: string;
    msg?: string;
}

interface MexcContractRaw {
    symbol?: string;
    state?: number;
    quoteCoin?: string;
    settleCoin?: string;
    contractSize?: number;
    minVol?: number;
    priceUnit?: number;
    volUnit?: number;
    priceScale?: number;
    volScale?: number;
}

interface MexcTickerRaw {
    symbol?: string;
    lastPrice?: number | string;
    amount24?: number | string;
    volume24?: number | string;
}

interface MexcPositionRaw {
    symbol?: string;
    positionType?: number;
    holdVol?: number | string;
    holdAvgPrice?: number | string;
}

interface MexcOrderRaw {
    orderId?: string | number;
    dealAvgPrice?: number | string;
    dealVol?: number | string;
    state?: number;
    side?: number;
}

interface MexcDealRaw {
    fee?: number | string;
    feeCurrency?: string;
    price?: number | string;
    vol?: number | string;
}

/**
 * MEXC USDT-futures (contract) native REST adapter.
 *
 * The contract API is signed by HMAC-SHA256 of `apiKey + timestamp + body`
 * (or `apiKey + timestamp + query` for GET). Order quantities are expressed
 * in contracts; the adapter converts base-coin amounts to contracts using
 * cached `contractSize` metadata, and converts filled contracts back to base
 * units before returning an `OrderResult`.
 */
export class MexcClient implements IExchangeClient {
    readonly name = 'Mexc';
    readonly exchangeKey = 'mexc';

    private readonly baseUrl: string;
    private readonly markets = new Map<string, MexcContractRaw>();

    constructor(private readonly apiKey: string, private readonly secret: string) {
        // MEXC has no published futures testnet; toggling does not change the
        // endpoint but keeps the surface uniform with other clients.
        this.baseUrl = 'https://contract.mexc.com';
        void config.useTestnet; // intentional: keep symmetry without dead var warning
    }

    async loadMarkets(): Promise<void> {
        const response = await this.publicRequest<MexcContractRaw[]>('GET', '/api/v1/contract/detail');
        this.markets.clear();
        for (const contract of response ?? []) {
            if (
                contract.symbol
                && contract.quoteCoin === 'USDT'
                && contract.settleCoin === 'USDT'
                // 0 = trading enabled per MEXC docs (states 1..5 = paused/maintenance/etc).
                && contract.state === 0
            ) {
                this.markets.set(contract.symbol, contract);
            }
        }
        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    /**
     * Log MEXC position mode (1 = hedge, 2 = one-way) at startup. MEXC's side
     * encoding (1=open_long / 2=close_long / 3=open_short / 4=close_short) is
     * identical in both modes per the docs, so this is purely diagnostic — it
     * surfaces the mode in logs and warns when the account is in one-way mode
     * so any unexpected rejections can be traced quickly. `symbol` is ignored
     * because MEXC position mode is account-level.
     */
    async prefetchAccountSettings(_symbol: string): Promise<void> {
        try {
            const raw = await this.signedRequest<number | { positionMode?: number }>(
                'GET',
                '/api/v1/private/position/position_mode',
                {},
            );
            const mode = typeof raw === 'number' ? raw : Number((raw ?? {}).positionMode ?? 0);
            const label = mode === 1 ? 'Hedge' : mode === 2 ? 'One-Way' : `Unknown(${mode})`;
            logger.info(TAG, `Account position mode: ${label}`);
            if (mode === 2) {
                logger.warn(
                    TAG,
                    'MEXC account is in one-way mode. Order side encoding stays the same per MEXC docs, but report any unexpected rejections.',
                );
            }
        } catch (e: unknown) {
            logger.warn(TAG, `prefetchAccountSettings failed: ${errorMessage(e)}`);
        }
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        try {
            // `openType=1` selects isolated margin in MEXC's combined endpoint.
            // `positionType=1`/`positionType=2` toggles long/short legs; we set
            // both so a buy followed by a sell uses the configured leverage.
            await this.signedRequest('POST', '/api/v1/private/position/change_leverage', {
                symbol: exchangeSymbol,
                leverage,
                openType: 1,
                positionType: 1,
            });
            await this.signedRequest('POST', '/api/v1/private/position/change_leverage', {
                symbol: exchangeSymbol,
                leverage,
                openType: 1,
                positionType: 2,
            });
        } catch (e: unknown) {
            // Treat MEXC leverage errors as warnings to mirror the previous
            // ccxt-based behaviour. Real failures still surface via the order
            // path, where they are unambiguous.
            logger.warn(TAG, `Failed to set leverage to ${leverage}x on MEXC for ${symbol}: ${errorMessage(e)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        // MEXC stores margin mode together with leverage; setLeverage already
        // sends `openType=1` (isolated), so no extra call is required. We log
        // at debug level to keep behaviour aligned with the previous adapter.
        logger.debug(TAG, `Isolated margin handled via leverage call for ${symbol}`);
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean } = {},
    ): Promise<OrderResult> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        const market = this.markets.get(exchangeSymbol);
        if (!market) throw new Error(`MEXC market not loaded for ${symbol}`);

        const contractSize = Number(market.contractSize ?? 1) || 1;
        const sizeInContracts = Math.max(1, Math.round(amount / contractSize));

        // MEXC side encoding: 1=open long, 2=close short, 3=open short, 4=close long.
        const orderSide = side === 'buy'
            ? (params.reduceOnly ? 2 : 1)
            : (params.reduceOnly ? 4 : 3);

        const body: Record<string, string | number> = {
            symbol: exchangeSymbol,
            vol: sizeInContracts,
            side: orderSide,
            type: 5, // market order
            openType: 1, // isolated margin
            leverage: 1, // placeholder; MEXC reuses last configured leverage per symbol
        };
        if (params.reduceOnly) body.reduceOnly = 'true';

        const orderResp = await this.signedRequest<string | number | { orderId?: string | number }>('POST', '/api/v1/private/order/submit', body);
        const orderId = typeof orderResp === 'object' && orderResp
            ? String(orderResp.orderId ?? '')
            : String(orderResp ?? '');

        let fetched: MexcOrderRaw | null = null;
        if (orderId) {
            await sleep(FAST_RETRY_MS);
            try {
                fetched = await this.fetchOrderRaw(orderId);
            } catch {
                fetched = null;
            }
        }

        const avgPrice = Number(fetched?.dealAvgPrice ?? 0);
        const filledContracts = Number(fetched?.dealVol ?? sizeInContracts) || sizeInContracts;
        const filledQty = filledContracts * contractSize;
        const result: OrderResult = {
            orderId: orderId,
            avgPrice,
            filledQty,
            commission: 0,
            commissionAsset: 'USDT',
            status: fetched?.state === 3 ? 'closed' : 'open',
            raw: fetched ?? { orderId },
        };
        logger.info(TAG, `Order placed: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, id=${result.orderId}`);
        return result;
    }

    async fetchOrderCommission(_symbol: string, orderId: string): Promise<number> {
        for (let i = 0; i < COMMISSION_DELAYS_MS.length; i++) {
            try {
                const deals = await this.signedRequest<MexcDealRaw[]>(
                    'GET',
                    `/api/v1/private/order/deal_details/${orderId}`,
                    {},
                );
                if (Array.isArray(deals) && deals.length > 0) {
                    let commission = 0;
                    for (const deal of deals) {
                        if (deal.feeCurrency === 'USDT' || deal.feeCurrency === 'USDC') {
                            commission += Math.abs(Number(deal.fee ?? 0));
                        }
                        // Non-stable fee currencies are intentionally ignored:
                        // MEXC occasionally credits promotional zero fees in MX,
                        // and a stale price-based conversion would distort PnL.
                    }
                    return commission;
                }
            } catch {
                // Retry until the deal feed flushes for this order.
            }
            await sleep(COMMISSION_DELAYS_MS[i]);
        }
        logger.warn(TAG, `Could not fetch commission for order ${orderId} after retries`);
        return 0;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.markets.get(unifiedToUnderscored(symbol));
        if (!market) return null;
        const contractSize = Number(market.contractSize ?? 1) || 1;
        const volUnit = Number(market.volUnit ?? 1) || 1;
        const priceUnit = Number(market.priceUnit ?? 0.001) || 0.001;
        const minVolContracts = Number(market.minVol ?? 1) || 1;
        const stepSizeBase = volUnit * contractSize;
        const minQtyBase = minVolContracts * contractSize;
        return {
            symbol,
            minQty: minQtyBase,
            stepSize: stepSizeBase,
            minNotional: 0,
            pricePrecision: priceUnit > 0 ? Math.max(0, Math.round(-Math.log10(priceUnit))) : 8,
            quantityPrecision: stepSizeBase > 0 ? Math.max(0, Math.round(-Math.log10(stepSizeBase))) : 8,
        };
    }

    getUsdtSymbols(): string[] {
        return [...this.markets.keys()].map(underscoredToUnified);
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const exchangeSymbols = new Set(symbols.map(unifiedToUnderscored));
        const positions = await this.signedRequest<MexcPositionRaw[]>('GET', '/api/v1/private/position/open_positions', {});
        const result: ExchangePosition[] = [];
        if (!Array.isArray(positions)) return result;
        for (const position of positions) {
            const exchangeSymbol = position.symbol;
            if (!exchangeSymbol || !exchangeSymbols.has(exchangeSymbol)) continue;
            const contracts = Number(position.holdVol ?? 0);
            if (!Number.isFinite(contracts) || contracts <= 0) continue;
            const market = this.markets.get(exchangeSymbol);
            const contractSize = Number(market?.contractSize ?? 1) || 1;
            result.push({
                symbol: underscoredToUnified(exchangeSymbol),
                side: position.positionType === 1 ? 'long' : 'short',
                size: contracts * contractSize,
                entryPrice: Number(position.holdAvgPrice ?? 0),
            });
        }
        return result;
    }

    async fetchTicker(symbol: string): Promise<ExchangeTicker> {
        const exchangeSymbol = unifiedToUnderscored(symbol);
        const ticker = await this.publicRequest<MexcTickerRaw>(
            'GET',
            `/api/v1/contract/ticker?symbol=${encodeURIComponent(exchangeSymbol)}`,
        );
        return {
            last: Number(ticker?.lastPrice ?? 0),
            quoteVolume: Number(ticker?.amount24 ?? ticker?.volume24 ?? 0),
        };
    }

    createMarketWs(store: OrderBookStore): MarketWsClient {
        return new MexcMarketWs(store);
    }

    private async fetchOrderRaw(orderId: string): Promise<MexcOrderRaw> {
        const order = await this.signedRequest<MexcOrderRaw>('GET', `/api/v1/private/order/get/${orderId}`, {});
        return order ?? {};
    }

    private async publicRequest<T>(
        method: 'GET' | 'POST',
        path: string,
        // public POST is currently unused; kept for API symmetry with other clients.
        _params: Record<string, string | number> = {},
    ): Promise<T> {
        const response = await requestJson<MexcResponse<T>>(`${this.baseUrl}${path}`, {
            method,
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (response.success === false && response.code !== 0 && response.code !== undefined) {
            throw new Error(`MEXC public REST failed: ${response.message ?? response.msg ?? response.code}`);
        }
        return response.data as T;
    }

    private async signedRequest<T>(
        method: 'GET' | 'POST',
        path: string,
        params: Record<string, string | number | boolean | undefined>,
    ): Promise<T> {
        if (!this.apiKey || !this.secret) {
            throw new Error('MEXC API credentials are required.');
        }
        const compact = compactParams(params);
        const timestamp = Date.now();
        const body = method === 'POST' ? JSON.stringify(compact) : '';
        const query = method === 'GET' ? buildSortedQuery(compact) : '';
        const signPayload = `${this.apiKey}${timestamp}${method === 'GET' ? query : body}`;
        const signature = createHmac('sha256', this.secret).update(signPayload).digest('hex');
        const url = query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'ApiKey': this.apiKey,
            'Request-Time': String(timestamp),
            'Signature': signature,
        };
        const response = await requestJson<MexcResponse<T>>(url, {
            method,
            headers,
            body: method === 'POST' ? body : undefined,
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (response.success === false || (response.code !== undefined && response.code !== 0 && response.code !== 200)) {
            throw new Error(`MEXC private REST failed (${response.code}): ${response.message ?? response.msg ?? 'unknown'}`);
        }
        return response.data as T;
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
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

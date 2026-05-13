import { createHmac } from 'node:crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import type { ExchangePosition, ExchangeTicker, MarketWsClient } from './market-ws.js';
import type { OrderBookStore } from '../market-data/orderbook-store.js';
import { BybitMarketWs } from './bybit-market-ws.js';
import { bybitToUnified, unifiedToBybit } from './symbols.js';
import { buildQuery, requestJson, sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BybitClient';
const REQUEST_TIMEOUT_MS = 10_000;
const RECV_WINDOW_MS = 15_000;
const TIME_OFFSET_TTL_MS = 60_000;
const FAST_RETRY_MS = 150;
const COMMISSION_DELAYS_MS = [200, 400, 800, 1500];

interface BybitResponse<T> {
    retCode: number;
    retMsg: string;
    result: T;
}

interface BybitList<T> {
    list?: T[];
    nextPageCursor?: string;
}

interface BybitInstrument {
    symbol?: string;
    status?: string;
    quoteCoin?: string;
    settleCoin?: string;
    priceFilter?: { tickSize?: string };
    lotSizeFilter?: {
        minOrderQty?: string;
        qtyStep?: string;
        minNotionalValue?: string;
    };
}

interface BybitTickerRaw {
    symbol?: string;
    lastPrice?: string;
    turnover24h?: string;
}

interface BybitPositionRaw {
    symbol?: string;
    side?: 'Buy' | 'Sell' | '';
    size?: string;
    avgPrice?: string;
}

interface BybitOrderRaw {
    orderId?: string;
    avgPrice?: string;
    cumExecQty?: string;
    cumExecFee?: string;
    orderStatus?: string;
    feeCurrency?: string;
}

interface BybitTimeRaw {
    timeNano?: string;
    timeSecond?: string;
}

type ApiErrorPredicate = (retCode: number, retMsg: string) => boolean;

/**
 * Bybit V5 linear-futures native REST adapter.
 *
 * The client signs every private request with HMAC-SHA256 over
 * `timestamp + apiKey + recvWindow + (query or body)` exactly as Bybit
 * documents. A cached server-time offset prevents clock-skew rejections
 * without paying for `/v5/market/time` on every signed call.
 */
export class BybitClient implements IExchangeClient {
    readonly name = 'Bybit';
    readonly exchangeKey = 'bybit';

    private readonly baseUrl: string;
    private readonly markets = new Map<string, BybitInstrument>();
    private timeOffsetMs: number | null = null;
    private timeOffsetExpiresAt = 0;
    // Per-symbol position-mode cache. Bybit V5 toggles Hedge vs One-Way
    // per-symbol on linear futures, so the flag has to live keyed by the
    // exchange symbol rather than as a single account-level boolean.
    private readonly positionModePromises = new Map<string, Promise<'hedge' | 'one-way'>>();

    constructor(private readonly apiKey: string, private readonly secret: string) {
        this.baseUrl = config.useTestnet
            ? 'https://api-testnet.bybit.com'
            : 'https://api.bybit.com';
    }

    async loadMarkets(): Promise<void> {
        const instruments = await this.fetchPublicPaginated<BybitInstrument>(
            '/v5/market/instruments-info',
            { category: 'linear', settleCoin: 'USDT', limit: 1000 },
        );
        this.markets.clear();
        for (const instrument of instruments) {
            if (
                instrument.status === 'Trading'
                && instrument.quoteCoin === 'USDT'
                && instrument.settleCoin === 'USDT'
                && instrument.symbol
            ) {
                this.markets.set(instrument.symbol, instrument);
            }
        }
        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        try {
            await this.privateRequest<unknown>(
                'POST',
                '/v5/position/set-leverage',
                {
                    category: 'linear',
                    symbol: unifiedToBybit(symbol),
                    buyLeverage: String(leverage),
                    sellLeverage: String(leverage),
                },
                isAlreadyConfigured,
            );
        } catch (e: unknown) {
            const message = errorMessage(e);
            throw new Error(`Failed to set leverage to ${leverage}x on Bybit: ${message}`);
        }
    }

    /**
     * Resolve per-symbol Hedge vs One-Way mode once before the first order.
     * `Engine.startBot` calls this in parallel with margin/leverage setup, and
     * the test-trade endpoint calls it before opening the leg. The cache
     * survives for the life of this client instance.
     */
    async prefetchAccountSettings(symbol: string): Promise<void> {
        try {
            const mode = await this.getPositionMode(symbol);
            logger.info(TAG, `Position mode for ${symbol}: ${mode === 'hedge' ? 'Hedge' : 'One-Way'}`);
        } catch (e: unknown) {
            logger.warn(TAG, `prefetchAccountSettings(${symbol}) failed: ${errorMessage(e)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        try {
            await this.privateRequest<unknown>(
                'POST',
                '/v5/position/switch-isolated',
                {
                    category: 'linear',
                    symbol: unifiedToBybit(symbol),
                    tradeMode: 1,
                    buyLeverage: '1',
                    sellLeverage: '1',
                },
                isIgnorableMarginModeResponse,
            );
        } catch (e: unknown) {
            // Bybit Unified Trading Accounts cannot switch per-symbol margin
            // modes; the `isIgnorableMarginModeResponse` predicate covers the
            // documented retCodes, so anything reaching this catch is a real
            // failure worth surfacing.
            throw new Error(`Failed to set isolated margin on Bybit: ${errorMessage(e)}`);
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean } = {},
    ): Promise<OrderResult> {
        const exchangeSymbol = unifiedToBybit(symbol);
        // Hedge Mode requires the position leg to be selected explicitly via
        // `positionIdx` (1 = LONG, 2 = SHORT). One-Way mode keeps the single
        // merged position at idx 0. `reduceOnly` is honoured in both modes —
        // unlike Binance, Bybit accepts the combination of positionIdx and
        // reduceOnly without complaint. Mode is resolved lazily if startBot
        // did not prefetch it (e.g. during test-trade with a fresh client).
        const mode = await this.getPositionMode(symbol);
        let positionIdx = 0;
        if (mode === 'hedge') {
            const closing = Boolean(params.reduceOnly);
            const longLeg = closing ? side === 'sell' : side === 'buy';
            positionIdx = longLeg ? 1 : 2;
        }
        const body: Record<string, string | number | boolean> = {
            category: 'linear',
            symbol: exchangeSymbol,
            side: side === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Market',
            qty: formatQuantity(amount),
            positionIdx,
        };
        if (params.reduceOnly) body.reduceOnly = true;

        const created = await this.privateRequest<{ orderId?: string; orderLinkId?: string }>(
            'POST',
            '/v5/order/create',
            body,
        );

        let fetched: BybitOrderRaw | null = null;
        if (created.orderId) {
            // Single fast retry to surface avgPrice + cumExecQty without
            // blocking the hot path. Bybit's matching engine usually finalises
            // a market fill within ~100ms but occasionally lags.
            await sleep(FAST_RETRY_MS);
            try {
                fetched = await this.fetchOrderRaw(exchangeSymbol, created.orderId);
            } catch {
                fetched = null;
            }
        }

        const avgPrice = Number(fetched?.avgPrice ?? 0);
        const filledQty = Number(fetched?.cumExecQty ?? amount) || amount;
        const result: OrderResult = {
            orderId: String(created.orderId ?? ''),
            avgPrice,
            filledQty,
            commission: 0,
            commissionAsset: 'USDT',
            status: fetched?.orderStatus === 'Filled' ? 'closed' : (fetched?.orderStatus?.toLowerCase() ?? 'unknown'),
            raw: fetched ?? created,
        };
        logger.info(TAG, `Order placed: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, id=${result.orderId}`);
        return result;
    }

    async fetchOrderCommission(symbol: string, orderId: string): Promise<number> {
        const exchangeSymbol = unifiedToBybit(symbol);
        for (let i = 0; i < COMMISSION_DELAYS_MS.length; i++) {
            try {
                const order = await this.fetchOrderRaw(exchangeSymbol, orderId);
                const commission = Math.abs(Number(order.cumExecFee ?? 0));
                if (commission > 0 || order.orderStatus === 'Filled') {
                    return commission;
                }
            } catch {
                // Retry until Bybit attaches realised fees to the order record.
            }
            await sleep(COMMISSION_DELAYS_MS[i]);
        }
        logger.warn(TAG, `Could not fetch commission for order ${orderId} after retries`);
        return 0;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.markets.get(unifiedToBybit(symbol));
        if (!market) return null;
        const lot = market.lotSizeFilter ?? {};
        const tickSize = Number(market.priceFilter?.tickSize ?? 0.001);
        const stepSize = Number(lot.qtyStep ?? 0.001);
        return {
            symbol,
            minQty: Number(lot.minOrderQty ?? 0),
            stepSize,
            minNotional: Number(lot.minNotionalValue ?? 0),
            pricePrecision: tickSize > 0 ? Math.max(0, Math.round(-Math.log10(tickSize))) : 8,
            quantityPrecision: stepSize > 0 ? Math.max(0, Math.round(-Math.log10(stepSize))) : 8,
        };
    }

    getUsdtSymbols(): string[] {
        return [...this.markets.keys()].map(bybitToUnified);
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const allowed = new Set(symbols.map(unifiedToBybit));
        const positions = await this.fetchPrivatePaginated<BybitPositionRaw>(
            '/v5/position/list',
            { category: 'linear', settleCoin: 'USDT', limit: 200 },
        );
        const result: ExchangePosition[] = [];
        for (const position of positions) {
            const exchangeSymbol = position.symbol;
            if (!exchangeSymbol || !allowed.has(exchangeSymbol)) continue;
            const size = Number(position.size ?? 0);
            if (!Number.isFinite(size) || size <= 0 || !position.side) continue;
            result.push({
                symbol: bybitToUnified(exchangeSymbol),
                side: position.side === 'Buy' ? 'long' : 'short',
                size,
                entryPrice: Number(position.avgPrice ?? 0),
            });
        }
        return result;
    }

    async fetchTicker(symbol: string): Promise<ExchangeTicker> {
        const data = await this.publicRequest<BybitList<BybitTickerRaw>>('/v5/market/tickers', {
            category: 'linear',
            symbol: unifiedToBybit(symbol),
        });
        const ticker = data.list?.[0];
        return {
            last: Number(ticker?.lastPrice ?? 0),
            quoteVolume: Number(ticker?.turnover24h ?? 0),
        };
    }

    createMarketWs(store: OrderBookStore): MarketWsClient {
        return new BybitMarketWs(store, config.useTestnet);
    }

    private getPositionMode(symbol: string): Promise<'hedge' | 'one-way'> {
        const key = unifiedToBybit(symbol);
        let pending = this.positionModePromises.get(key);
        if (pending) return pending;
        pending = this.privateRequest<BybitList<BybitPositionRaw & { positionIdx?: number }>>(
            'GET',
            '/v5/position/list',
            { category: 'linear', symbol: key },
        )
            .then(res => {
                // Hedge Mode returns two entries with positionIdx 1 and 2,
                // even when both sides have size=0. One-Way returns a single
                // entry with positionIdx 0. If neither shape is present (rare
                // for UTA accounts with no historic position on the symbol),
                // default to One-Way — Bybit accepts positionIdx=0 there.
                const list = res.list ?? [];
                const hedge = list.some(p => (p as any).positionIdx === 1 || (p as any).positionIdx === 2);
                return hedge ? ('hedge' as const) : ('one-way' as const);
            })
            .catch(e => {
                // Drop the cached failure so a later call can retry instead of
                // permanently sticking to a fallback. Treat probe failures as
                // One-Way: that matches Bybit's default for UTA accounts and
                // keeps the order path responsive.
                logger.warn(TAG, `Position mode probe for ${symbol} failed, assuming One-Way: ${errorMessage(e)}`);
                this.positionModePromises.delete(key);
                return 'one-way' as const;
            });
        this.positionModePromises.set(key, pending);
        return pending;
    }

    private async fetchOrderRaw(exchangeSymbol: string, orderId: string): Promise<BybitOrderRaw> {
        const result = await this.privateRequest<BybitList<BybitOrderRaw>>(
            'GET',
            '/v5/order/realtime',
            { category: 'linear', symbol: exchangeSymbol, orderId },
        );
        const order = result.list?.[0];
        if (order) return order;
        // realtime returns only active orders; if the order is already filled
        // it will appear in the history endpoint instead.
        const historic = await this.privateRequest<BybitList<BybitOrderRaw>>(
            'GET',
            '/v5/order/history',
            { category: 'linear', symbol: exchangeSymbol, orderId, limit: 1 },
        );
        return historic.list?.[0] ?? {};
    }

    private async fetchPublicPaginated<T>(
        endpoint: string,
        params: Record<string, string | number>,
    ): Promise<T[]> {
        const all: T[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.publicRequest<BybitList<T>>(endpoint, { ...params, cursor });
            all.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);
        return all;
    }

    private async fetchPrivatePaginated<T>(
        endpoint: string,
        params: Record<string, string | number>,
    ): Promise<T[]> {
        const all: T[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.privateRequest<BybitList<T>>('GET', endpoint, { ...params, cursor });
            all.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);
        return all;
    }

    private async publicRequest<T>(
        endpoint: string,
        params: Record<string, string | number | undefined>,
    ): Promise<T> {
        const compact = compactParams(params);
        const query = buildQuery(compact);
        const url = query ? `${this.baseUrl}${endpoint}?${query}` : `${this.baseUrl}${endpoint}`;
        const response = await requestJson<BybitResponse<T>>(url, { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS });
        if (response.retCode !== 0) {
            throw new Error(`Bybit public REST failed: ${response.retMsg}`);
        }
        return response.result;
    }

    private async privateRequest<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        params: Record<string, string | number | boolean | undefined>,
        ignore: ApiErrorPredicate = () => false,
    ): Promise<T> {
        if (!this.apiKey || !this.secret) {
            throw new Error('Bybit API credentials are required.');
        }
        const compact = compactParams(params);
        let response = await this.sendPrivate<T>(method, endpoint, compact);
        if (response.retCode !== 0 && isTimestampWindowError(response.retMsg)) {
            // Refresh the time-offset cache and retry once. Cheaper than paying
            // for `/v5/market/time` before every signed call.
            await this.refreshTimeOffset();
            response = await this.sendPrivate<T>(method, endpoint, compact);
        }
        if (response.retCode !== 0 && !ignore(response.retCode, response.retMsg)) {
            throw new Error(`Bybit private REST failed (${response.retCode}): ${response.retMsg}`);
        }
        return response.result;
    }

    private async sendPrivate<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        params: Record<string, string | number | boolean>,
    ): Promise<BybitResponse<T>> {
        const recvWindow = String(RECV_WINDOW_MS);
        const timestamp = String(await this.signedTimestamp());
        const body = method === 'POST' ? JSON.stringify(params) : '';
        const query = method === 'GET' ? buildQuery(params) : '';
        const signPayload = `${timestamp}${this.apiKey}${recvWindow}${method === 'GET' ? query : body}`;
        const signature = createHmac('sha256', this.secret).update(signPayload).digest('hex');
        const url = query ? `${this.baseUrl}${endpoint}?${query}` : `${this.baseUrl}${endpoint}`;
        return requestJson<BybitResponse<T>>(url, {
            method,
            body: method === 'POST' ? body : undefined,
            timeoutMs: REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': this.apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'X-BAPI-SIGN': signature,
            },
        });
    }

    private async signedTimestamp(): Promise<number> {
        if (this.timeOffsetMs === null || Date.now() >= this.timeOffsetExpiresAt) {
            await this.refreshTimeOffset();
        }
        return Date.now() + (this.timeOffsetMs ?? 0);
    }

    private async refreshTimeOffset(): Promise<void> {
        const requestedAt = Date.now();
        const response = await requestJson<BybitResponse<BybitTimeRaw>>(
            `${this.baseUrl}/v5/market/time`,
            { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const receivedAt = Date.now();
        if (response.retCode !== 0) {
            throw new Error(`Bybit time REST failed: ${response.retMsg}`);
        }
        const serverTime = bybitServerTimeMs(response.result);
        if (serverTime === null) {
            throw new Error('Bybit time REST returned an invalid timestamp.');
        }
        const localMidpoint = Math.floor((requestedAt + receivedAt) / 2);
        this.timeOffsetMs = serverTime - localMidpoint;
        this.timeOffsetExpiresAt = receivedAt + TIME_OFFSET_TTL_MS;
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

function isAlreadyConfigured(retCode: number): boolean {
    // Bybit treats no-op leverage/margin updates as errors with these specific
    // codes. Engine startup is idempotent so we map them to success.
    return retCode === 110043 || retCode === 110025;
}

function isIgnorableMarginModeResponse(retCode: number, retMsg: string): boolean {
    if (isAlreadyConfigured(retCode)) return true;
    if (retCode === 110026 || retCode === 110027 || retCode === 110028 || retCode === 3400045) return true;
    const normalized = retMsg.toLowerCase();
    return normalized.includes('unified account')
        || normalized.includes('not modified')
        || normalized.includes('isolated');
}

function isTimestampWindowError(retMsg: string): boolean {
    const normalized = retMsg.toLowerCase();
    return normalized.includes('timestamp') || normalized.includes('recv_window');
}

function bybitServerTimeMs(time: BybitTimeRaw): number | null {
    const nano = Number(time.timeNano);
    if (Number.isFinite(nano) && nano > 0) return Math.floor(nano / 1_000_000);
    const second = Number(time.timeSecond);
    if (Number.isFinite(second) && second > 0) return Math.floor(second * 1000);
    return null;
}

function formatQuantity(value: number): string {
    return Number(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

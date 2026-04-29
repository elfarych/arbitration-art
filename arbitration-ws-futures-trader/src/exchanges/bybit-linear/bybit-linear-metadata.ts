import { createHmac } from 'node:crypto';
import type { ExchangePosition, PositionReader, SymbolMarketInfo } from '../exchange-types.js';
import { exchangeToUnified, unifiedToExchangeSymbol } from '../symbols.js';
import { buildQuery, requestJson } from '../../utils/http.js';
import { appConfig } from '../../config.js';

const MAINNET_REST = 'https://api.bybit.com';
const TESTNET_REST = 'https://api-testnet.bybit.com';
const TIME_OFFSET_TTL_MS = 60_000;

interface BybitResponse<T> {
    retCode: number;
    retMsg: string;
    result: T;
}

type BybitApiErrorPredicate = (retCode: number, retMsg: string) => boolean;

interface BybitList<T> {
    list?: T[];
    nextPageCursor?: string;
}

interface BybitInstrument {
    symbol?: string;
    status?: string;
    contractType?: string;
    quoteCoin?: string;
    settleCoin?: string;
    lotSizeFilter?: {
        minOrderQty?: string;
        qtyStep?: string;
        minNotionalValue?: string;
    };
}

interface BybitTicker {
    symbol?: string;
    turnover24h?: string;
    price24hPcnt?: string;
    lastPrice?: string;
}

interface BybitTime {
    timeSecond?: string;
    timeNano?: string;
}

interface BybitPosition {
    symbol?: string;
    side?: 'Buy' | 'Sell' | '';
    size?: string;
    avgPrice?: string;
}

export interface BybitMetadataOptions {
    apiKey?: string;
    apiSecret?: string;
    useTestnet: boolean;
}

export class BybitLinearMetadata implements PositionReader {
    readonly exchange = 'bybit' as const;
    private timeOffsetMs: number | null = null;
    private timeOffsetExpiresAt = 0;

    constructor(private readonly options: BybitMetadataOptions) {}

    async loadMarketInfo(): Promise<Map<string, SymbolMarketInfo>> {
        const [instruments, tickers] = await Promise.all([
            this.fetchPaginated<BybitInstrument>('/v5/market/instruments-info', {
                category: 'linear',
                settleCoin: 'USDT',
                limit: 1000,
            }),
            this.publicRequest<BybitList<BybitTicker>>('/v5/market/tickers', {
                category: 'linear',
            }),
        ]);

        const volumeBySymbol = new Map<string, number>();
        const priceChangeBySymbol = new Map<string, number>();
        for (const ticker of tickers.list ?? []) {
            if (ticker.symbol) {
                volumeBySymbol.set(ticker.symbol, Number(ticker.turnover24h ?? 0));
                priceChangeBySymbol.set(ticker.symbol, finiteNumber(ticker.price24hPcnt) * 100);
            }
        }

        const result = new Map<string, SymbolMarketInfo>();
        for (const instrument of instruments) {
            if (!isTradeableUsdtLinear(instrument)) {
                continue;
            }

            const exchangeSymbol = instrument.symbol;
            if (!exchangeSymbol) {
                continue;
            }

            const lot = instrument.lotSizeFilter ?? {};
            const unified = exchangeToUnified(exchangeSymbol);
            result.set(unified, {
                symbol: unified,
                exchange: 'bybit',
                exchangeSymbol,
                minQty: Number(lot.minOrderQty ?? 0),
                stepSize: Number(lot.qtyStep ?? 0),
                minNotional: Number(lot.minNotionalValue ?? 0),
                quoteVolume: volumeBySymbol.get(exchangeSymbol) ?? 0,
                priceChangePercent24h: priceChangeBySymbol.get(exchangeSymbol) ?? 0,
            });
        }
        return result;
    }

    async setLeverageAndMargin(symbol: string, leverage: number): Promise<void> {
        const exchangeSymbol = unifiedToExchangeSymbol(symbol);
        await this.privateRequest<unknown>('POST', '/v5/position/switch-isolated', {
            category: 'linear',
            symbol: exchangeSymbol,
            tradeMode: 1,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage),
        }, [200], isIgnorableMarginModeResponse);
        await this.privateRequest<unknown>('POST', '/v5/position/set-leverage', {
            category: 'linear',
            symbol: exchangeSymbol,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage),
        }, [200], isAlreadyConfigured);
    }

    async fetchOpenPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const allowed = new Set(symbols.map(unifiedToExchangeSymbol));
        const positions = await this.fetchPrivatePaginated<BybitPosition>('/v5/position/list', {
            category: 'linear',
            settleCoin: 'USDT',
            limit: 200,
        });
        return positions.flatMap(position => {
            const exchangeSymbol = position.symbol;
            if (!exchangeSymbol || !allowed.has(exchangeSymbol)) {
                return [];
            }
            const size = Number(position.size ?? 0);
            if (!Number.isFinite(size) || size <= 0 || !position.side) {
                return [];
            }
            return [{
                exchange: 'bybit' as const,
                symbol: exchangeToUnified(exchangeSymbol),
                side: position.side === 'Buy' ? 'long' as const : 'short' as const,
                quantity: size,
                entryPrice: Number(position.avgPrice ?? 0),
            }];
        });
    }

    async fetchLastPrice(symbol: string): Promise<number> {
        const result = await this.publicRequest<BybitList<BybitTicker>>('/v5/market/tickers', {
            category: 'linear',
            symbol: unifiedToExchangeSymbol(symbol),
        });
        const price = Number(result.list?.[0]?.lastPrice ?? 0);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Bybit price is unavailable for ${symbol}.`);
        }
        return price;
    }

    private async fetchPaginated<T>(endpoint: string, params: Record<string, string | number>): Promise<T[]> {
        const all: T[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.publicRequest<BybitList<T>>(endpoint, { ...params, cursor });
            all.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);
        return all;
    }

    private async fetchPrivatePaginated<T>(endpoint: string, params: Record<string, string | number>): Promise<T[]> {
        const all: T[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.privateRequest<BybitList<T>>('GET', endpoint, { ...params, cursor });
            all.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);
        return all;
    }

    private async publicRequest<T>(endpoint: string, params: Record<string, string | number | undefined>): Promise<T> {
        const query = buildQuery(params);
        const url = query ? `${this.baseUrl()}${endpoint}?${query}` : `${this.baseUrl()}${endpoint}`;
        const response = await requestJson<BybitResponse<T>>(url);
        if (response.retCode !== 0) {
            throw new Error(`Bybit public REST failed: ${response.retMsg}`);
        }
        return response.result;
    }

    private async privateRequest<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        params: Record<string, string | number | undefined>,
        expectedStatuses: number[] = [200],
        ignoreApiError: BybitApiErrorPredicate = () => false,
    ): Promise<T> {
        if (!this.options.apiKey || !this.options.apiSecret) {
            throw new Error('Bybit API credentials are required for private REST bootstrap.');
        }
        const apiKey = this.options.apiKey;
        const apiSecret = this.options.apiSecret;

        const compactParams = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) as Record<string, string | number>;
        let response = await this.sendPrivateRequest<T>(method, endpoint, compactParams, expectedStatuses, apiKey, apiSecret);

        if (response.retCode !== 0 && isTimestampWindowError(response.retMsg)) {
            await this.refreshTimeOffset();
            response = await this.sendPrivateRequest<T>(method, endpoint, compactParams, expectedStatuses, apiKey, apiSecret);
        }

        if (response.retCode !== 0 && !ignoreApiError(response.retCode, response.retMsg)) {
            throw new Error(`Bybit private REST failed: ${response.retMsg}`);
        }

        return response.result;
    }

    private async sendPrivateRequest<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        compactParams: Record<string, string | number>,
        expectedStatuses: number[],
        apiKey: string,
        apiSecret: string,
    ): Promise<BybitResponse<T>> {
        const recvWindow = String(appConfig.bybitRecvWindowMs);
        const timestamp = String(await this.signedTimestamp());
        const body = method === 'POST' ? JSON.stringify(compactParams) : '';
        const query = method === 'GET' ? buildQuery(compactParams) : '';
        const signPayload = `${timestamp}${apiKey}${recvWindow}${method === 'GET' ? query : body}`;
        const signature = createHmac('sha256', apiSecret).update(signPayload).digest('hex');
        const url = query ? `${this.baseUrl()}${endpoint}?${query}` : `${this.baseUrl()}${endpoint}`;
        return requestJson<BybitResponse<T>>(url, {
            method,
            body: method === 'POST' ? body : undefined,
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'X-BAPI-SIGN': signature,
            },
        }, expectedStatuses);
    }

    private async signedTimestamp(): Promise<number> {
        if (this.timeOffsetMs === null || Date.now() >= this.timeOffsetExpiresAt) {
            await this.refreshTimeOffset();
        }
        return Date.now() + (this.timeOffsetMs ?? 0);
    }

    private async refreshTimeOffset(): Promise<void> {
        const requestedAt = Date.now();
        const response = await requestJson<BybitResponse<BybitTime>>(`${this.baseUrl()}/v5/market/time`);
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

    private baseUrl(): string {
        return this.options.useTestnet ? TESTNET_REST : MAINNET_REST;
    }
}

function isTradeableUsdtLinear(instrument: BybitInstrument): boolean {
    return instrument.status === 'Trading'
        && instrument.quoteCoin === 'USDT'
        && instrument.settleCoin === 'USDT'
        && Boolean(instrument.symbol);
}

export function isAlreadyConfigured(retCode: number): boolean {
    return retCode === 110043 || retCode === 110025;
}

export function isIgnorableMarginModeResponse(retCode: number, retMsg: string): boolean {
    return isAlreadyConfigured(retCode) || isUnifiedAccountForbidden(retMsg);
}

function isUnifiedAccountForbidden(retMsg: string): boolean {
    const normalized = retMsg.toLowerCase();
    return normalized.includes('unified account') && normalized.includes('forbidden');
}

function isTimestampWindowError(retMsg: string): boolean {
    const normalized = retMsg.toLowerCase();
    return normalized.includes('timestamp') || normalized.includes('recv_window');
}

function bybitServerTimeMs(time: BybitTime): number | null {
    const nano = Number(time.timeNano);
    if (Number.isFinite(nano) && nano > 0) {
        return Math.floor(nano / 1_000_000);
    }

    const second = Number(time.timeSecond);
    if (Number.isFinite(second) && second > 0) {
        return Math.floor(second * 1000);
    }

    return null;
}

function finiteNumber(value: string | undefined): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
}

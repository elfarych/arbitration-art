import { createHmac } from 'node:crypto';
import type { ExchangePosition, PositionReader, SymbolMarketInfo } from '../exchange-types.js';
import { exchangeToUnified, unifiedToExchangeSymbol } from '../symbols.js';
import { buildQuery, requestJson } from '../../utils/http.js';

const MAINNET_REST = 'https://fapi.binance.com';
const TESTNET_REST = 'https://testnet.binancefuture.com';

interface BinanceExchangeInfo {
    symbols?: BinanceSymbolInfo[];
}

interface BinanceSymbolInfo {
    symbol?: string;
    status?: string;
    contractType?: string;
    quoteAsset?: string;
    filters?: Array<Record<string, string>>;
}

interface BinanceTicker {
    symbol?: string;
    quoteVolume?: string;
    priceChangePercent?: string;
    price?: string;
}

interface BinancePositionRisk {
    symbol?: string;
    positionAmt?: string;
    entryPrice?: string;
}

export interface BinanceMetadataOptions {
    apiKey?: string;
    apiSecret?: string;
    useTestnet: boolean;
}

export class BinanceUsdmMetadata implements PositionReader {
    readonly exchange = 'binance' as const;

    constructor(private readonly options: BinanceMetadataOptions) {}

    async loadMarketInfo(): Promise<Map<string, SymbolMarketInfo>> {
        const [exchangeInfo, tickers] = await Promise.all([
            requestJson<BinanceExchangeInfo>(`${this.baseUrl()}/fapi/v1/exchangeInfo`),
            requestJson<BinanceTicker[]>(`${this.baseUrl()}/fapi/v1/ticker/24hr`),
        ]);
        const volumeBySymbol = new Map<string, number>();
        const priceChangeBySymbol = new Map<string, number>();
        for (const ticker of tickers) {
            if (ticker.symbol) {
                volumeBySymbol.set(ticker.symbol, Number(ticker.quoteVolume ?? 0));
                priceChangeBySymbol.set(ticker.symbol, finiteNumber(ticker.priceChangePercent));
            }
        }

        const result = new Map<string, SymbolMarketInfo>();
        for (const symbolInfo of exchangeInfo.symbols ?? []) {
            if (!isTradeableUsdtPerpetual(symbolInfo)) {
                continue;
            }

            const exchangeSymbol = symbolInfo.symbol;
            if (!exchangeSymbol) {
                continue;
            }

            const lotSize = findFilter(symbolInfo, 'LOT_SIZE');
            const minNotional = findFilter(symbolInfo, 'MIN_NOTIONAL');
            const unified = exchangeToUnified(exchangeSymbol);
            result.set(unified, {
                symbol: unified,
                exchange: 'binance',
                exchangeSymbol,
                minQty: Number(lotSize?.minQty ?? 0),
                stepSize: Number(lotSize?.stepSize ?? 0),
                minNotional: Number(minNotional?.notional ?? minNotional?.minNotional ?? 0),
                quoteVolume: volumeBySymbol.get(exchangeSymbol) ?? 0,
                priceChangePercent24h: priceChangeBySymbol.get(exchangeSymbol) ?? 0,
            });
        }
        return result;
    }

    async setLeverageAndMargin(symbol: string, leverage: number): Promise<void> {
        await this.signedRequest('POST', '/fapi/v1/marginType', {
            symbol: unifiedToExchangeSymbol(symbol),
            marginType: 'ISOLATED',
        }, [200, 400]);
        await this.signedRequest('POST', '/fapi/v1/leverage', {
            symbol: unifiedToExchangeSymbol(symbol),
            leverage,
        });
    }

    async fetchOpenPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const positions = await this.signedRequest<BinancePositionRisk[]>('GET', '/fapi/v3/positionRisk', {});
        const allowed = new Set(symbols.map(unifiedToExchangeSymbol));
        return positions.flatMap(position => {
            const exchangeSymbol = position.symbol;
            if (!exchangeSymbol || !allowed.has(exchangeSymbol)) {
                return [];
            }
            const amount = Number(position.positionAmt ?? 0);
            if (!Number.isFinite(amount) || amount === 0) {
                return [];
            }
            return [{
                exchange: 'binance' as const,
                symbol: exchangeToUnified(exchangeSymbol),
                side: amount > 0 ? 'long' as const : 'short' as const,
                quantity: Math.abs(amount),
                entryPrice: Number(position.entryPrice ?? 0),
            }];
        });
    }

    async fetchLastPrice(symbol: string): Promise<number> {
        const exchangeSymbol = unifiedToExchangeSymbol(symbol);
        const ticker = await requestJson<BinanceTicker>(
            `${this.baseUrl()}/fapi/v1/ticker/price?symbol=${encodeURIComponent(exchangeSymbol)}`,
        );
        const price = Number(ticker.price ?? 0);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Binance price is unavailable for ${symbol}.`);
        }
        return price;
    }

    private async signedRequest<T>(
        method: 'GET' | 'POST',
        endpoint: string,
        params: Record<string, string | number>,
        expectedStatuses: number[] = [200],
    ): Promise<T> {
        if (!this.options.apiKey || !this.options.apiSecret) {
            throw new Error('Binance API credentials are required for private REST bootstrap.');
        }

        const signedParams = {
            ...params,
            timestamp: Date.now(),
            recvWindow: 5000,
        };
        const query = buildQuery(signedParams);
        const signature = createHmac('sha256', this.options.apiSecret).update(query).digest('hex');
        const url = `${this.baseUrl()}${endpoint}?${query}&signature=${signature}`;
        return requestJson<T>(url, {
            method,
            headers: {
                'X-MBX-APIKEY': this.options.apiKey,
            },
        }, expectedStatuses);
    }

    private baseUrl(): string {
        return this.options.useTestnet ? TESTNET_REST : MAINNET_REST;
    }
}

function isTradeableUsdtPerpetual(symbol: BinanceSymbolInfo): boolean {
    return symbol.status === 'TRADING'
        && symbol.contractType === 'PERPETUAL'
        && symbol.quoteAsset === 'USDT'
        && Boolean(symbol.symbol);
}

function findFilter(symbol: BinanceSymbolInfo, filterType: string): Record<string, string> | null {
    return symbol.filters?.find(filter => filter.filterType === filterType) ?? null;
}

function finiteNumber(value: string | undefined): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
}

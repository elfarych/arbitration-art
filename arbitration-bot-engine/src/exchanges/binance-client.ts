import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BinanceClient';

function ccxtToBinance(symbol: string): string {
    // Convert ccxt futures symbol format (BTC/USDT:USDT) into Binance REST API
    // format (BTCUSDT).
    return symbol.replace(':USDT', '').replace('/', '');
}

function binanceToCcxt(binanceSymbol: string): string {
    // Convert Binance REST symbols back into the ccxt futures format used by
    // WebSocket orderbooks and Django bot config.
    if (binanceSymbol.endsWith('USDT')) {
        return binanceSymbol.replace('USDT', '/USDT:USDT');
    }
    return binanceSymbol;
}

/**
 * Binance USDT-M futures REST adapter.
 *
 * This client uses direct signed REST calls instead of ccxt for order execution
 * so it can control Binance-specific request signing, order polling, and fee
 * extraction from /userTrades.
 */
export class BinanceClient implements IExchangeClient {
    public readonly name = 'Binance';
    private httpClient: AxiosInstance;
    private baseUrl: string;
    private markets: Map<string, any> = new Map();

    constructor() {
        // Toggle between Binance Futures testnet and production using USE_TESTNET.
        this.baseUrl = config.useTestnet 
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 10000,
        });

        this.httpClient.interceptors.response.use(
            response => response,
            error => {
                // Normalize Binance error payloads into Error.message so callers
                // can log/propagate one consistent exception shape.
                if (error.response?.data) {
                    throw new Error(`Binance API Error: ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        );
    }

    get ccxtInstance(): any {
        // BotTrader expects a small ccxt-like surface for market data and
        // position recovery. This adapter implements only the methods it needs.
        return {
            fetchTime: async () => {
                const res = await this.request('GET', '/fapi/v1/time', {}, false);
                return res.serverTime;
            },
            fetchTickers: async () => {
                // MarketInfoService uses last prices to size trades and detect
                // ticker collisions across exchanges.
                const data = await this.request('GET', '/fapi/v1/ticker/24hr', {}, false);
                const tickers: any = {};
                for (const t of data) {
                    tickers[binanceToCcxt(t.symbol)] = {
                        last: Number(t.lastPrice),
                        quoteVolume: Number(t.quoteVolume)
                    };
                }
                return tickers;
            },
            fetchPositions: async (symbols: string[]) => {
                // Return positions in a ccxt-like shape so BotTrader cleanup and
                // close logic can be exchange-agnostic.
                const results: any[] = [];
                for (const symbol of symbols) {
                    try {
                        const binanceSymbol = ccxtToBinance(symbol);
                        const posArray = await this.request('GET', '/fapi/v2/positionRisk', { symbol: binanceSymbol });
                        
                        // Binance returns array of positions for the symbol
                        if (Array.isArray(posArray)) {
                            for (const pos of posArray) {
                                const amount = Number(pos.positionAmt);
                                if (Math.abs(amount) > 0) {
                                    results.push({
                                        symbol: symbol,
                                        contracts: Math.abs(amount),
                                        amount: Math.abs(amount),
                                        side: amount > 0 ? 'long' : 'short',
                                        entryPrice: Number(pos.entryPrice),
                                    });
                                }
                            }
                        }
                    } catch (e: any) {
                        logger.error(TAG, `Failed to fetch positions for ${symbol}: ${e.message}`);
                    }
                }
                return results;
            }
        };
    }

    /**
     * Executes an authenticated or unauthenticated request to Binance API.
     */
    private async request(method: 'GET' | 'POST' | 'DELETE', endpoint: string, params: Record<string, any> = {}, auth: boolean = true) {
        let queryString = '';

        if (auth) {
            // Binance signed endpoints require timestamp, recvWindow and HMAC
            // signature over the exact query string.
            params.timestamp = Date.now();
            params.recvWindow = 5000;
            
            queryString = Object.keys(params)
                .map(k => `${k}=${encodeURIComponent(params[k])}`)
                .join('&');
            
            const signature = crypto.createHmac('sha256', config.binance.secret)
                .update(queryString)
                .digest('hex');
                
            queryString += `&signature=${signature}`;
        } else {
            queryString = Object.keys(params)
                .map(k => `${k}=${encodeURIComponent(params[k])}`)
                .join('&');
        }

        const headers: Record<string, string> = {};
        if (auth) {
            // API key is sent in the header; secret is used only for the HMAC.
            headers['X-MBX-APIKEY'] = config.binance.apiKey;
        }

        let url = endpoint;
        let data = undefined;

        if (method === 'GET' || method === 'DELETE') {
            if (queryString) url += `?${queryString}`;
        } else {
            // POST prefers form-urlencoded body
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            data = queryString;
        }

        const response = await this.httpClient.request({
            method,
            url,
            data,
            headers
        });

        return response.data;
    }

    async loadMarkets(): Promise<void> {
        // Cache exchangeInfo once per client startup. Order sizing later reads
        // filters from this map without making another network request.
        const info = await this.request('GET', '/fapi/v1/exchangeInfo', {}, false);
        this.markets.clear();

        if (info && Array.isArray(info.symbols)) {
            for (const sym of info.symbols) {
                if (sym.contractType === 'PERPETUAL' && sym.quoteAsset === 'USDT') {
                    this.markets.set(sym.symbol, sym);
                }
            }
            logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
        } else {
            throw new Error(`Failed to load exchange info from Binance`);
        }
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const binanceSymbol = ccxtToBinance(symbol);
        try {
            await this.request('POST', '/fapi/v1/leverage', {
                symbol: binanceSymbol,
                leverage: leverage.toString()
            });
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
        } catch (e: any) {
            // Binance reports "No need to change" as an error response, but for
            // engine setup it is an idempotent success.
            if (e.message?.includes('No need to change')) {
                logger.debug(TAG, `Leverage already ${leverage}x for ${symbol}`);
            } else {
                throw new Error(`Failed to set leverage to ${leverage}x on Binance: ${e.message}`);
            }
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        const binanceSymbol = ccxtToBinance(symbol);
        try {
            await this.request('POST', '/fapi/v1/marginType', {
                symbol: binanceSymbol,
                marginType: 'ISOLATED'
            });
            logger.debug(TAG, `Isolated margin set for ${symbol}`);
        } catch (e: any) {
            // Same idempotency handling as leverage: already-isolated is not a
            // setup failure.
            if (e.message?.includes('No need to change')) {
                logger.debug(TAG, `Margin already isolated for ${symbol}`);
            } else {
                throw new Error(`Failed to set isolated margin on Binance: ${e.message}`);
            }
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number, // Base currency
        params: any = {},
    ): Promise<OrderResult> {
        const binanceSymbol = ccxtToBinance(symbol);
        
        logger.info(TAG, `Creating ${side} order for ${symbol}, amount: ${amount}`);

        // Construct formatting for Binance (usually accepts up to 5-6 digits or raw number strings)
        // precision truncating is handled by Trader.ts before being passed here
        const quantityStr = Number(amount).toFixed(10).replace(/\.?0+$/, '');
        
        const orderParams: any = {
            symbol: binanceSymbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantityStr
        };

        if (params.reduceOnly) {
            orderParams.reduceOnly = 'true';
        }

        let orderData;
        try {
            orderData = await this.request('POST', '/fapi/v1/order', orderParams);
        } catch (e: any) {
            throw new Error(`Binance order failed: ${e.message}`);
        }

        let filled = orderData;
        const orderId = orderData.orderId;

        // DB Lag fallback: give exchange matching engine 500ms to calculate fills before fetching
        let avgPrice = parseFloat(filled.avgPrice || filled.price || '0');
        
        if (avgPrice === 0 || filled.status !== 'FILLED') {
            await new Promise(r => setTimeout(r, 500));
            try {
                const checked = await this.request('GET', '/fapi/v1/order', {
                    symbol: binanceSymbol,
                    orderId: orderId
                });
                if (checked) {
                    filled = checked;
                    avgPrice = parseFloat(filled.avgPrice || '0');
                }
            } catch (e) {
                // Ignore fetch errors during polling
            }
        }

        // Commission extraction using User Trades. The initial order response can
        // omit final fee details, especially immediately after a market fill.
        let commission = 0;
        try {
            // Wait 500ms to ensure trades are flushed to db
            await new Promise(r => setTimeout(r, 500));
            
            const trades = await this.request('GET', '/fapi/v1/userTrades', {
                symbol: binanceSymbol,
                orderId: orderId
            });

            if (Array.isArray(trades)) {
                for (const t of trades) {
                    const fee = parseFloat(t.commission || '0');
                    if (t.commissionAsset === 'BNB') {
                        // Calculate USD equivalent fallback at the time of trade
                        // (Usually the bot wants to report strictly in USDT, CCXT applied a hardcoded BNB rate factor)
                        // If they pay in BNB, the discount fee is usually calculated based on the trade volume
                        const notional = parseFloat(t.price || '0') * parseFloat(t.qty || '0');
                        commission += (notional * 0.00045); // Approximate 0.045% VIP0 taker rate with BNB discount
                    } else {
                        // USDT, BUSD or USDC fees are treated as quote-currency
                        // equivalents for Django reporting.
                        commission += Math.abs(fee);
                    }
                }
            }
        } catch (e: any) {
            logger.warn(TAG, `Failed to extract trades for order ${orderId}, fee left 0: ${e.message}`);
        }

        const result: OrderResult = {
            orderId: String(filled.orderId),
            avgPrice: avgPrice,
            filledQty: parseFloat(filled.executedQty || '0') || amount,
            commission: commission,
            commissionAsset: 'USDT',
            status: filled.status === 'FILLED' ? 'closed' : filled.status?.toLowerCase(),
            raw: filled,
        };

        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        // Convert Binance filters into the engine's common sizing metadata.
        const binanceSymbol = ccxtToBinance(symbol);
        const market = this.markets.get(binanceSymbol);
        
        if (!market) return null;

        let tickSize = 0.001;
        let stepSize = 0.001;
        let minQty = 0;
        let minNotional = 0;

        for (const f of market.filters || []) {
            if (f.filterType === 'PRICE_FILTER') {
                tickSize = Number(f.tickSize);
            }
            if (f.filterType === 'LOT_SIZE') {
                stepSize = Number(f.stepSize);
                minQty = Number(f.minQty);
            }
            if (f.filterType === 'MIN_NOTIONAL') {
                minNotional = Number(f.notional);
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
        // Expose symbols in ccxt futures format because the rest of the engine is
        // keyed by ccxt symbols.
        const symbols: string[] = [];
        for (const sym of this.markets.keys()) {
            symbols.push(binanceToCcxt(sym));
        }
        return symbols;
    }
}

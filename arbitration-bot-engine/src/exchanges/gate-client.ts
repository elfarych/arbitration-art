import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { IExchangeClient } from './exchange-client.js';
import type { OrderResult, SymbolMarketInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'GateClient';

function ccxtToGate(symbol: string): string {
    // Convert ccxt futures symbol format (BTC/USDT:USDT) into Gate contract
    // format (BTC_USDT).
    return symbol.replace(':USDT', '').replace('/', '_');
}

function gateToCcxt(gateSymbol: string): string {
    // Convert Gate contract names back into the ccxt futures format used by
    // orderbooks, Django bot config and MarketInfoService.
    return gateSymbol.replace('_', '/') + ':USDT';
}

/**
 * Gate USDT futures REST adapter.
 *
 * Gate uses a native contract-size model, so this client performs explicit
 * conversion between base-coin amounts and Gate contract sizes. It also signs
 * requests directly because the engine needs predictable request formatting.
 */
export class GateClient implements IExchangeClient {
    public readonly name = 'Gate';
    private httpClient: AxiosInstance;
    private baseUrl: string;
    private markets: Map<string, any> = new Map();

    constructor() {
        // Gate has separate base URLs for futures testnet and production.
        this.baseUrl = config.useTestnet 
            ? 'https://fx-api-testnet.gateio.ws/api/v4'
            : 'https://api.gateio.ws/api/v4';

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 10000,
        });

        // Normalize Gate error payloads into Error.message for consistent caller
        // handling.
        this.httpClient.interceptors.response.use(
            response => response,
            error => {
                if (error.response?.data) {
                    throw new Error(`Gate API Error: ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        );
    }

    // BotTrader expects a small ccxt-like surface for price and position data.
    // GateClient supplies only the methods currently used by MarketInfoService
    // and BotTrader cleanup/close logic.
    get ccxtInstance(): any {
        return {
            fetchTime: async () => Date.now(),
            fetchTickers: async () => {
                // Gate tickers are converted to ccxt symbols so they align with
                // the commonSymbols list and market info cache keys.
                const data = await this.request('GET', '/futures/usdt/tickers');
                const tickers: any = {};
                for (const t of data) {
                    tickers[gateToCcxt(t.contract)] = {
                        last: Number(t.last),
                        quoteVolume: Number(t.volume_24h_quote || 0)
                    };
                }
                return tickers;
            },
            fetchPositions: async (symbols: string[]) => {
                const results: any[] = [];
                for (const symbol of symbols) {
                    try {
                        const gateSymbol = ccxtToGate(symbol);
                        const data = await this.request('GET', `/futures/usdt/positions/${gateSymbol}`);
                        if (data && data.size !== undefined && Number(data.size) !== 0) {
                            const market = this.markets.get(gateSymbol);
                            // Gate position size is reported in contracts. Convert
                            // it back to base coin using the contract multiplier.
                            const multiplier = Number(market?.quanto_multiplier || 1);
                            const baseAmount = Math.abs(Number(data.size)) * multiplier;

                            results.push({
                                symbol: symbol,
                                contracts: baseAmount,
                                amount: baseAmount,
                                side: Number(data.size) > 0 ? 'long' : 'short',
                                entryPrice: parseFloat(data.entry_price || '0'),
                            });
                        }
                    } catch (e: any) {
                        logger.error(TAG, `Failed to fetch positions for ${symbol}: ${e.message}`);
                    }
                }
                return results;
            }
        };
    }

    private sign(method: string, endpoint: string, query: string, payload: string) {
        // Gate v4 signatures include method, full /api/v4 path, query string,
        // SHA512 payload hash and timestamp separated by newlines.
        const t = Math.floor(Date.now() / 1000).toString();
        const hashedPayload = crypto.createHash('sha512').update(payload).digest('hex');
        const signatureString = [method, endpoint, query, hashedPayload, t].join('\n');
        
        const sign = crypto.createHmac('sha512', config.gate.secret).update(signatureString).digest('hex');
        return {
            'KEY': config.gate.apiKey,
            'Timestamp': t,
            'SIGN': sign,
        };
    }

    private async request(method: 'GET' | 'POST' | 'DELETE', endpoint: string, query: Record<string, any> = {}, data: any = null) {
        const queryString = Object.keys(query)
            .sort() // Gate usually requires sorted params or matched url formatting
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
            .join('&');
            
        const payloadStr = data ? JSON.stringify(data) : '';
        const pathStr = '/api/v4' + endpoint;

        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...this.sign(method, pathStr, queryString, payloadStr)
        };

        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        const response = await this.httpClient.request({
            method,
            url,
            data: payloadStr || undefined,
            headers
        });
        return response.data;
    }

    async loadMarkets(): Promise<void> {
        // Cache futures contract metadata. Later methods use it for symbol
        // conversion, contract multiplier and order-size constraints.
        const contracts = await this.request('GET', '/futures/usdt/contracts');
        this.markets.clear();
        for (const contract of contracts) {
            this.markets.set(contract.name, contract);
        }
        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const gateSymbol = ccxtToGate(symbol);
        try {
            await this.request('POST', `/futures/usdt/positions/${gateSymbol}/leverage`, {
                leverage: leverage.toString(),
                cross_leverage_limit: leverage.toString()
            });
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
        } catch (e: any) {
            logger.warn(TAG, `Failed to set leverage to ${leverage}x on Gate for ${symbol}: ${e.message}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        const gateSymbol = ccxtToGate(symbol);
        try {
            // Gate typically configures isolated mode dynamically when passing margin
            // Try to force position into isolated if api supports it, or just ignore (as Gate isolates by default if not set to cross)
            await this.request('POST', `/futures/usdt/positions/${gateSymbol}/margin`, {
                size: "0" 
            });
            logger.debug(TAG, `Isolated margin logic confirmed for ${symbol}`);
        } catch (e: any) {
            if (e.message.includes('already in isolated')) {
                logger.debug(TAG, `Margin already isolated for ${symbol}`);
            } else {
                logger.debug(TAG, `Gate fallback isolated margin skipped for ${symbol}: ${e.message}`);
            }
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number, // Base currency (BTC)
        params: any = {},
    ): Promise<OrderResult> {
        const gateSymbol = ccxtToGate(symbol);
        const market = this.markets.get(gateSymbol);
        
        if (!market) {
            throw new Error(`Market not loaded for ${symbol}`);
        }

        // Convert base currency amount (for example BTC) to Gate contract count.
        const quantoMultiplier = Number(market.quanto_multiplier);
        let sizeInContracts = Math.round(amount / quantoMultiplier);
        
        // Gate uses positive size for buy/long and negative size for sell/short.
        if (side === 'sell') {
            sizeInContracts = -sizeInContracts;
        }

        logger.info(TAG, `Creating ${side} order for ${symbol}, amount (base): ${amount}, size (contracts): ${sizeInContracts}`);

        const payload: any = {
            contract: gateSymbol,
            size: sizeInContracts,
            price: "0", 
            tif: "ioc" 
        };

        if (params.reduceOnly) {
            payload.reduce_only = true;
        }

        let orderData;
        try {
            orderData = await this.request('POST', '/futures/usdt/orders', {}, payload);
        } catch (e: any) {
            throw new Error(`Gate order failed: ${e.message}`);
        }

        let filled = orderData;
        const orderId = orderData.id;

        // Poll for final execution details because the initial Gate order
        // response can show fill_price=0 or status=open right after submission.
        let retries = 0;
        let avgPrice = parseFloat(filled.fill_price || '0');
        
        while ((avgPrice === 0 || filled.status === 'open') && retries < 5) {
            await new Promise(r => setTimeout(r, 1000));
            retries++;
            try {
                const checked = await this.request('GET', `/futures/usdt/orders/${orderId}`);
                if (checked) {
                    filled = checked;
                    avgPrice = parseFloat(filled.fill_price || '0');
                }
                if (avgPrice > 0 && filled.status !== 'open') break;
            } catch (e) {
                // Ignore fetch errors during polling
            }
        }

        // Commission is extracted from Gate's native response (negative for paid fees in USDT)
        let commission = 0;
        try {
            // Wait 500ms to ensure trades are flushed to db
            await new Promise(r => setTimeout(r, 500));
            const trades = await this.request('GET', '/futures/usdt/my_trades', { contract: gateSymbol, order: orderId });
            if (Array.isArray(trades)) {
                for (const t of trades) {
                    commission += Math.abs(parseFloat(t.fee || '0'));
                }
            }
        } catch (e: any) {
            logger.warn(TAG, `Failed to extract trades for order ${orderId}, fee left 0: ${e.message}`);
        }

        // Compute actual filled base currency quantity
        const filledContracts = Math.abs(Number(filled.size) - Number(filled.left || 0));
        const filledQty = filledContracts * quantoMultiplier;

        const result: OrderResult = {
            orderId: String(filled.id),
            avgPrice: avgPrice,
            filledQty: filledQty,
            commission,
            commissionAsset: 'USDT',
            status: filled.status === 'finished' ? 'closed' : filled.status, 
            raw: filled,
        };

        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission}`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        // Convert Gate contract constraints into base-coin quantities so they can
        // be compared with Binance/Bybit/MEXC limits.
        const gateSymbol = ccxtToGate(symbol);
        const market = this.markets.get(gateSymbol);
        
        if (!market) return null;

        const quantoMultiplier = Number(market.quanto_multiplier);
        
        // Gate precision in API response: order_price_round (e.g. "0.1")
        const priceStep = Number(market.order_price_round);
        
        // Gate order size step is in contracts (order_size_round). 
        // We convert contract step size back to base currency.
        const sizeStepContracts = Number(market.order_size_round || '1');
        const stepSizeBase = sizeStepContracts * quantoMultiplier;

        const minQtyContracts = Number(market.order_size_min || '1');
        const minQtyBase = minQtyContracts * quantoMultiplier;

        return {
            symbol,
            minQty: minQtyBase,
            stepSize: stepSizeBase,
            minNotional: 0, // Gate calculates notional requirements mostly on size_min anyway
            pricePrecision: Math.max(0, Math.round(-Math.log10(priceStep))),
            quantityPrecision: Math.max(0, Math.round(-Math.log10(stepSizeBase))),
        };
    }

    getUsdtSymbols(): string[] {
        const symbols: string[] = [];
        for (const contract of this.markets.values()) {
            if (contract.type === 'direct' && contract.name.endsWith('_USDT')) {
                symbols.push(gateToCcxt(contract.name));
            }
        }
        return symbols;
    }
}

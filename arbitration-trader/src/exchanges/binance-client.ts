import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { ExchangeClientOptions, IExchangeClient } from './exchange-client.js';
import type { ExchangePosition, ExchangeTicker, OrderResult, SymbolMarketInfo } from '../types/index.js';
import { binanceToUnified, unifiedToBinance } from './symbols.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BinanceClient';

/**
 * Binance USDT-M futures REST client.
 *
 * This adapter uses direct signed REST calls so it can control Binance-specific
 * request signing, fill polling and commission extraction.
 */
export class BinanceClient implements IExchangeClient {
    public readonly name = 'Binance';
    private httpClient: AxiosInstance;
    private baseUrl: string;
    private markets: Map<string, any> = new Map();
    private apiKey: string;
    private secret: string;

    constructor(options: ExchangeClientOptions = {}) {
        const useTestnet = options.useTestnet ?? config.useTestnet;
        this.apiKey = options.apiKey ?? config.binance.apiKey;
        this.secret = options.secret ?? config.binance.secret;

        // Toggle between Binance Futures testnet and production.
        this.baseUrl = useTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 10000,
        });

        this.httpClient.interceptors.response.use(
            response => response,
            error => {
                // Normalize exchange error payloads into Error.message.
                if (error.response?.data) {
                    throw new Error(`Binance API Error: ${JSON.stringify(error.response.data)}`);
                }
                throw error;
            }
        );
    }

    async fetchTime(): Promise<number> {
        const res = await this.request('GET', '/fapi/v1/time', {}, false);
        return Number(res.serverTime);
    }

    async fetchTickers(symbols?: string[]): Promise<Record<string, ExchangeTicker>> {
        const params = symbols?.length === 1
            ? { symbol: unifiedToBinance(symbols[0]) }
            : {};
        const data = await this.request('GET', '/fapi/v1/ticker/24hr', params, false);
        const rows = Array.isArray(data) ? data : [data];
        const requested = symbols ? new Set(symbols) : null;
        const tickers: Record<string, ExchangeTicker> = {};
        const fundingBySymbol = await this.fetchFundingSnapshots(symbols);

        for (const ticker of rows) {
            const symbol = binanceToUnified(String(ticker.symbol));
            if (requested && !requested.has(symbol)) {
                continue;
            }

            const funding = fundingBySymbol[symbol];
            tickers[symbol] = {
                symbol,
                last: Number(ticker.lastPrice),
                quoteVolume: Number(ticker.quoteVolume),
                fundingRate: funding?.fundingRate ?? null,
                nextFundingTime: funding?.nextFundingTime ?? null,
                raw: ticker,
            };
        }

        return tickers;
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const requested = new Set(symbols);
        const params = symbols.length === 1
            ? { symbol: unifiedToBinance(symbols[0]) }
            : {};
        const data = await this.request('GET', '/fapi/v3/positionRisk', params);
        const rows = Array.isArray(data) ? data : [data];
        const positions: ExchangePosition[] = [];

        for (const position of rows) {
            const symbol = binanceToUnified(String(position.symbol));
            if (!requested.has(symbol)) {
                continue;
            }

            const signedAmount = Number(position.positionAmt);
            if (Math.abs(signedAmount) <= 0) {
                continue;
            }

            const positionSide = String(position.positionSide || '').toUpperCase();
            const side = positionSide === 'SHORT'
                ? 'short'
                : positionSide === 'LONG'
                    ? 'long'
                    : signedAmount > 0 ? 'long' : 'short';

            positions.push({
                symbol,
                contracts: Math.abs(signedAmount),
                amount: Math.abs(signedAmount),
                side,
                entryPrice: Number(position.entryPrice),
                raw: position,
            });
        }

        return positions;
    }

    /**
     * Executes an authenticated or unauthenticated request to Binance API.
     */
    private async request(method: 'GET' | 'POST' | 'DELETE', endpoint: string, params: Record<string, any> = {}, auth: boolean = true) {
        let queryString = '';

        if (auth) {
            // Binance signed endpoints require timestamp, recvWindow and HMAC over
            // the exact query string.
            params.timestamp = Date.now();
            params.recvWindow = 5000;
            
            queryString = Object.keys(params)
                .map(k => `${k}=${encodeURIComponent(params[k])}`)
                .join('&');
            
            const signature = crypto.createHmac('sha256', this.secret)
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
            // Secret is used only for HMAC signing; API key goes in the header.
            headers['X-MBX-APIKEY'] = this.apiKey;
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

    async pingPrivate(): Promise<void> {
        await this.request('GET', '/fapi/v2/account');
    }

    async validateAccountMode(): Promise<void> {
        const data = await this.request('GET', '/fapi/v1/positionSide/dual');
        if (data?.dualSidePosition === true) {
            throw new Error('Binance hedge mode is enabled; trader requires one-way position mode.');
        }
    }

    async loadMarkets(): Promise<void> {
        // Cache exchangeInfo once during bootstrap.
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
        const binanceSymbol = unifiedToBinance(symbol);
        try {
            await this.request('POST', '/fapi/v1/leverage', {
                symbol: binanceSymbol,
                leverage: leverage.toString()
            });
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
        } catch (e: any) {
            // Binance reports already-set leverage as an error; treat it as
            // idempotent success.
            if (e.message?.includes('No need to change')) {
                logger.debug(TAG, `Leverage already ${leverage}x for ${symbol}`);
            } else {
                throw new Error(`Failed to set leverage to ${leverage}x on Binance: ${e.message}`);
            }
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        const binanceSymbol = unifiedToBinance(symbol);
        try {
            await this.request('POST', '/fapi/v1/marginType', {
                symbol: binanceSymbol,
                marginType: 'ISOLATED'
            });
            logger.debug(TAG, `Isolated margin set for ${symbol}`);
        } catch (e: any) {
            // Binance reports already-isolated margin as an error; treat it as
            // idempotent success.
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
        amount: number, // Base currency amount.
        params: { reduceOnly?: boolean; clientOrderId?: string } = {},
    ): Promise<OrderResult> {
        const binanceSymbol = unifiedToBinance(symbol);
        const clientOrderId = params.clientOrderId || this.createClientOrderId();
        
        logger.info(TAG, `Creating ${side} order for ${symbol}, amount: ${amount}`);

        // Construct quantity formatting. Trader already rounded the amount to a
        // valid lot size before calling the client.
        const quantityStr = Number(amount).toFixed(10).replace(/\.?0+$/, '');
        
        const orderParams: any = {
            symbol: binanceSymbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantityStr,
            newClientOrderId: clientOrderId,
            newOrderRespType: 'RESULT',
        };

        if (params.reduceOnly) {
            orderParams.reduceOnly = 'true';
        }

        if (params.clientOrderId) {
            orderParams.newClientOrderId = params.clientOrderId;
        }

        let orderData;
        try {
            orderData = await this.request('POST', '/fapi/v1/order', orderParams);
        } catch (e: any) {
            const reconciled = await this.reconcileSubmittedOrder(binanceSymbol, clientOrderId, amount);
            if (reconciled) {
                this.assertFilledMarketOrder(reconciled, clientOrderId, amount);
                logger.info(TAG, `Order filled after reconciliation: ${symbol} ${side} @ ${reconciled.avgPrice}, qty: ${reconciled.filledQty}, commission: ${reconciled.commission} USDT`);
                return reconciled;
            }

            throw new Error(`Binance order failed: ${e.message}`);
        }

        let filled = orderData;
        const orderId = orderData.orderId;

        // Binance can return the order before final average price is available,
        // so poll until status and average fill are final.
        let avgPrice = parseFloat(filled.avgPrice || filled.price || '0');

        for (let attempt = 0; attempt < 6 && (avgPrice <= 0 || filled.status !== 'FILLED'); attempt++) {
            await new Promise(r => setTimeout(r, 700));
            try {
                const checked = await this.request('GET', '/fapi/v1/order', {
                    symbol: binanceSymbol,
                    orderId: orderId
                });
                if (checked) {
                    filled = checked;
                    avgPrice = parseFloat(filled.avgPrice || '0');
                }
            } catch (e: any) {
                logger.warn(TAG, `Failed to poll Binance order ${orderId}: ${e.message}`);
            }
        }

        // Extract commission from User Trades because order responses can omit
        // final fee details.
        let commission = 0;
        let tradesFilledQty = 0;
        let tradesNotional = 0;
        try {
            // Give Binance time to flush fills into userTrades.
            await new Promise(r => setTimeout(r, 500));
            
            const trades = await this.request('GET', '/fapi/v1/userTrades', {
                symbol: binanceSymbol,
                orderId: orderId
            });

            if (Array.isArray(trades)) {
                for (const t of trades) {
                    const price = parseFloat(t.price || '0');
                    const qty = parseFloat(t.qty || '0');
                    if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0) {
                        tradesFilledQty += qty;
                        tradesNotional += price * qty;
                    }

                    const fee = parseFloat(t.commission || '0');
                    if (t.commissionAsset === 'BNB') {
                        // Approximate quote-equivalent commission from the fill
                        // notional when Binance charges the fee in BNB.
                        const notional = price * qty;
                        commission += (notional * 0.00045);
                    } else {
                        // USDT, BUSD or USDC fees are treated as quote-equivalent.
                        commission += Math.abs(fee);
                    }
                }
            }
        } catch (e: any) {
            logger.warn(TAG, `Failed to extract trades for order ${orderId}, fee left 0: ${e.message}`);
        }

        const responseFilledQty = parseFloat(filled.executedQty || '0');
        const filledQty = tradesFilledQty > 0 ? tradesFilledQty : responseFilledQty;
        if (avgPrice <= 0 && tradesFilledQty > 0) {
            avgPrice = tradesNotional / tradesFilledQty;
        }

        const result: OrderResult = {
            orderId: String(filled.orderId),
            avgPrice: avgPrice,
            filledQty,
            commission: commission,
            commissionAsset: 'USDT',
            status: filled.status === 'FILLED' ? 'closed' : filled.status?.toLowerCase(),
            raw: filled,
        };

        this.assertFilledMarketOrder(result, String(orderId), amount);
        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    private async reconcileSubmittedOrder(
        binanceSymbol: string,
        clientOrderId: string,
        requestedAmount: number,
    ): Promise<OrderResult | null> {
        try {
            await new Promise(r => setTimeout(r, 700));
            const order = await this.request('GET', '/fapi/v1/order', {
                symbol: binanceSymbol,
                origClientOrderId: clientOrderId,
            });

            const avgPrice = parseFloat(order.avgPrice || order.price || '0');
            const filledQty = parseFloat(order.executedQty || '0');
            const result: OrderResult = {
                orderId: String(order.orderId || clientOrderId),
                avgPrice,
                filledQty,
                commission: 0,
                commissionAsset: 'USDT',
                status: order.status === 'FILLED' ? 'closed' : String(order.status || 'unknown').toLowerCase(),
                raw: order,
            };

            if (filledQty < requestedAmount * (1 - 1e-8)) {
                return result;
            }

            return result;
        } catch {
            return null;
        }
    }

    private assertFilledMarketOrder(result: OrderResult, orderRef: string, requestedAmount: number): void {
        const isFullFill = result.filledQty >= requestedAmount * (1 - 1e-8);
        if (result.filledQty <= 0 || result.avgPrice <= 0 || result.status !== 'closed' || !isFullFill) {
            throw new Error(
                `Binance market order ${orderRef} did not fully fill: status=${result.status}, filled=${result.filledQty}, requested=${requestedAmount}, avgPrice=${result.avgPrice}`,
            );
        }
    }

    private createClientOrderId(): string {
        return `aa_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`.slice(0, 36);
    }

    private async fetchFundingSnapshots(symbols?: string[]): Promise<Record<string, { fundingRate: number | null; nextFundingTime: number | null }>> {
        try {
            const params = symbols?.length === 1
                ? { symbol: unifiedToBinance(symbols[0]) }
                : {};
            const data = await this.request('GET', '/fapi/v1/premiumIndex', params, false);
            const rows = Array.isArray(data) ? data : [data];
            const requested = symbols ? new Set(symbols) : null;
            const result: Record<string, { fundingRate: number | null; nextFundingTime: number | null }> = {};

            for (const row of rows) {
                const symbol = binanceToUnified(String(row.symbol));
                if (requested && !requested.has(symbol)) {
                    continue;
                }

                result[symbol] = {
                    fundingRate: parseNullableNumber(row.lastFundingRate),
                    nextFundingTime: parseNullableTimestamp(row.nextFundingTime),
                };
            }

            return result;
        } catch (error: any) {
            logger.warn(TAG, `Failed to fetch Binance funding snapshots: ${error.message}`);
            return {};
        }
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        // Convert Binance filters into the common SymbolMarketInfo shape.
        const binanceSymbol = unifiedToBinance(symbol);
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
        const symbols: string[] = [];
        for (const sym of this.markets.keys()) {
            symbols.push(binanceToUnified(sym));
        }
        return symbols;
    }
}

function parseNullableNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableTimestamp(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

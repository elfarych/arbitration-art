import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { ExchangeClientOptions, IExchangeClient } from './exchange-client.js';
import type { ExchangePosition, ExchangeTicker, OrderResult, SymbolMarketInfo } from '../types/index.js';
import { mexcToUnified, unifiedToMexc } from './symbols.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'MexcClient';
const BASE_URL = 'https://contract.mexc.com';
const SETTLE_COIN = 'USDT';
const ISOLATED_OPEN_TYPE = 1;
const POSITION_TYPE_LONG = 1;
const POSITION_TYPE_SHORT = 2;
const ORDER_TYPE_MARKET = 5;
const ORDER_POLL_ATTEMPTS = 6;
const ORDER_POLL_DELAY_MS = 700;
const DEAL_POLL_ATTEMPTS = 3;
const DEAL_POLL_DELAY_MS = 500;

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface MexcResponse<T> {
    success: boolean;
    code: number;
    message?: string;
    data: T;
}

interface MexcContract {
    symbol: string;
    baseCoin?: string;
    quoteCoin?: string;
    settleCoin?: string;
    contractSize?: string | number;
    minLeverage?: string | number;
    maxLeverage?: string | number;
    priceScale?: string | number;
    volScale?: string | number;
    amountScale?: string | number;
    priceUnit?: string | number;
    volUnit?: string | number;
    minVol?: string | number;
    maxVol?: string | number;
    takerFeeRate?: string | number;
    makerFeeRate?: string | number;
    state?: number;
    apiAllowed?: boolean;
}

interface MexcTicker {
    symbol: string;
    lastPrice?: string | number;
    fairPrice?: string | number;
    indexPrice?: string | number;
    volume24?: string | number;
    amount24?: string | number;
    lower24Price?: string | number;
    high24Price?: string | number;
    timestamp?: string | number;
    fundingRate?: string | number;
    nextSettleTime?: string | number;
}

interface MexcPosition {
    positionId?: string | number;
    symbol?: string;
    positionType?: number;
    openType?: number;
    state?: number;
    holdVol?: string | number;
    frozenVol?: string | number;
    holdAvgPrice?: string | number;
    openAvgPrice?: string | number;
    leverage?: string | number;
}

interface MexcOrder {
    orderId?: string | number;
    symbol?: string;
    positionId?: string | number;
    price?: string | number;
    vol?: string | number;
    leverage?: string | number;
    side?: number;
    category?: number;
    orderType?: number;
    dealAvgPrice?: string | number;
    dealVol?: string | number;
    takerFee?: string | number;
    makerFee?: string | number;
    feeCurrency?: string;
    profit?: string | number;
    openType?: number;
    state?: number;
    externalOid?: string;
    errorCode?: number;
    createTime?: string | number;
    updateTime?: string | number;
}

interface MexcDeal {
    id?: string | number;
    symbol?: string;
    side?: number;
    vol?: string | number;
    price?: string | number;
    feeCurrency?: string;
    fee?: string | number;
    timestamp?: string | number;
    orderId?: string | number;
    taker?: boolean;
    isTaker?: boolean;
}

class MexcApiError extends Error {
    constructor(
        public readonly code: number | null,
        message: string,
        public readonly raw?: unknown,
    ) {
        super(message);
        this.name = 'MexcApiError';
    }
}

/**
 * MEXC Contract API client for USDT perpetual futures.
 *
 * MEXC order payloads use contract `vol`, while the trading loop works in base
 * coin amounts. This adapter keeps that conversion explicit through
 * `contractSize` and never retries order submission without reconciling by
 * `externalOid`.
 */
export class MexcClient implements IExchangeClient {
    public readonly name = 'Mexc';

    private readonly httpClient: AxiosInstance;
    private readonly apiKey: string;
    private readonly secret: string;
    private readonly useTestnet: boolean;
    private readonly markets: Map<string, MexcContract> = new Map();
    private positionMode: number | null = null;

    constructor(options: ExchangeClientOptions = {}) {
        this.useTestnet = options.useTestnet ?? config.useTestnet;
        this.apiKey = options.apiKey ?? config.mexc.apiKey;
        this.secret = options.secret ?? config.mexc.secret;

        this.httpClient = axios.create({
            baseURL: BASE_URL,
            timeout: 10000,
        });
    }

    async fetchTime(): Promise<number> {
        const serverTime = await this.request<number>('GET', '/api/v1/contract/ping', {}, null, false);
        return Number(serverTime);
    }

    async fetchTickers(symbols?: string[]): Promise<Record<string, ExchangeTicker>> {
        const requested = symbols ? new Set(symbols) : null;
        const params = symbols?.length === 1
            ? { symbol: unifiedToMexc(symbols[0]) }
            : {};
        const data = await this.request<MexcTicker[] | MexcTicker>('GET', '/api/v1/contract/ticker', params, null, false);
        const rows = Array.isArray(data) ? data : [data];
        const tickers: Record<string, ExchangeTicker> = {};

        for (const ticker of rows) {
            if (!ticker.symbol?.endsWith(`_${SETTLE_COIN}`)) {
                continue;
            }

            const symbol = mexcToUnified(ticker.symbol);
            if (requested && !requested.has(symbol)) {
                continue;
            }

            const last = Number(ticker.lastPrice ?? ticker.fairPrice ?? ticker.indexPrice ?? 0);
            const quoteVolume = this.extractQuoteVolume(ticker, last);
            tickers[symbol] = {
                symbol,
                last,
                quoteVolume,
                fundingRate: parseNullableNumber(ticker.fundingRate),
                nextFundingTime: parseNullableTimestamp(ticker.nextSettleTime),
                raw: ticker,
            };
        }

        return tickers;
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        if (symbols.length === 0) {
            return [];
        }

        const results: ExchangePosition[] = [];

        for (const symbol of symbols) {
            const mexcSymbol = unifiedToMexc(symbol);

            try {
                const positions = await this.fetchNativePositions(mexcSymbol);
                for (const position of positions) {
                    const normalized = this.normalizePosition(position, symbol);
                    if (!normalized) {
                        continue;
                    }

                    results.push(normalized);
                }
            } catch (error: any) {
                const message = this.formatError(error);
                logger.error(TAG, `Failed to fetch positions for ${symbol}: ${message}`);
                throw new Error(`Failed to fetch MEXC position for ${symbol}: ${message}`);
            }
        }

        return results;
    }

    async fetchAllOpenPositions(): Promise<ExchangePosition[]> {
        const positions = await this.fetchNativePositions();
        return positions
            .map(position => this.normalizePosition(position))
            .filter((position): position is ExchangePosition => position !== null);
    }

    async loadMarkets(): Promise<void> {
        const contracts = await this.request<MexcContract[]>('GET', '/api/v1/contract/detail', {}, null, false);
        this.markets.clear();

        for (const contract of contracts) {
            if (this.isTradeableUsdtContract(contract)) {
                this.markets.set(contract.symbol, contract);
            }
        }

        if (this.markets.size === 0) {
            throw new Error('Failed to load MEXC USDT perpetual markets');
        }

        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        this.assertPrivateRequestsAllowed();
        const mexcSymbol = unifiedToMexc(symbol);
        const market = this.getMarketOrThrow(mexcSymbol, symbol);
        const minLeverage = Number(market.minLeverage || 1);
        const maxLeverage = Number(market.maxLeverage || leverage);

        if (
            !Number.isFinite(leverage)
            || leverage < minLeverage
            || (Number.isFinite(maxLeverage) && leverage > maxLeverage)
        ) {
            throw new Error(`MEXC leverage ${leverage}x is outside ${symbol} limits ${minLeverage}-${maxLeverage}`);
        }

        try {
            const openPositions = await this.fetchNativePositions(mexcSymbol);
            const positionsByType = new Map<number, MexcPosition>();
            for (const position of openPositions) {
                if (position.positionType === POSITION_TYPE_LONG || position.positionType === POSITION_TYPE_SHORT) {
                    positionsByType.set(position.positionType, position);
                }
            }

            await Promise.all([
                this.changeLeverageForSide(mexcSymbol, POSITION_TYPE_LONG, leverage, positionsByType.get(POSITION_TYPE_LONG)),
                this.changeLeverageForSide(mexcSymbol, POSITION_TYPE_SHORT, leverage, positionsByType.get(POSITION_TYPE_SHORT)),
            ]);
            logger.debug(TAG, `Isolated leverage set to ${leverage}x for ${symbol}`);
        } catch (error: any) {
            throw new Error(`Failed to set isolated leverage to ${leverage}x on MEXC for ${symbol}: ${this.formatError(error)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        this.assertPrivateRequestsAllowed();
        if (!Number.isFinite(config.leverage) || config.leverage <= 0) {
            throw new Error(`MEXC isolated margin requires a positive leverage for ${symbol}`);
        }

        // MEXC sets isolated mode through `openType: 1` on leverage and order
        // requests. Runtime validates the actual setup in setLeverage().
        logger.debug(TAG, `MEXC isolated margin for ${symbol} is controlled by openType=1 on leverage/order requests.`);
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean; clientOrderId?: string } = {},
    ): Promise<OrderResult> {
        this.assertPrivateRequestsAllowed();
        const mexcSymbol = unifiedToMexc(symbol);
        const market = this.getMarketOrThrow(mexcSymbol, symbol);
        const contractSize = this.getContractSizeOrThrow(mexcSymbol, symbol);
        const orderContracts = this.baseAmountToContracts(mexcSymbol, amount, contractSize);
        const expectedBaseAmount = orderContracts * contractSize;
        const externalOid = this.createExternalOid(params.clientOrderId);
        const orderSide = this.getOrderSide(side, Boolean(params.reduceOnly));
        const positionMode = await this.getPositionModeForOrder(params.reduceOnly);

        logger.info(TAG, `Creating ${side} order for ${symbol}, amount (base): ${amount}, vol (contracts): ${orderContracts}`);

        const payload: Record<string, unknown> = {
            symbol: mexcSymbol,
            price: 0,
            vol: orderContracts,
            leverage: config.leverage,
            side: orderSide,
            type: ORDER_TYPE_MARKET,
            openType: ISOLATED_OPEN_TYPE,
            externalOid,
        };

        if (positionMode !== null) {
            payload.positionMode = positionMode;
        }

        if (params.reduceOnly && positionMode === 2) {
            payload.reduceOnly = true;
        }

        let orderId: string | undefined;
        try {
            const createdId = await this.request<string | number>('POST', '/api/v1/private/order/submit', {}, payload);
            orderId = String(createdId);
        } catch (error: any) {
            const reconciled = await this.reconcileSubmittedOrder(mexcSymbol, externalOid, expectedBaseAmount, contractSize);
            if (reconciled) {
                this.assertFilledMarketOrder(reconciled, externalOid, expectedBaseAmount);
                logger.info(TAG, `Order filled after reconciliation: ${symbol} ${side} @ ${reconciled.avgPrice}, qty: ${reconciled.filledQty}, commission: ${reconciled.commission} USDT`);
                return reconciled;
            }

            throw new Error(`MEXC order failed: ${this.formatError(error)}`);
        }

        const result = await this.waitForOrderResult(mexcSymbol, orderId, externalOid, expectedBaseAmount, contractSize);

        this.assertFilledMarketOrder(result, orderId || externalOid, expectedBaseAmount);
        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const mexcSymbol = unifiedToMexc(symbol);
        const market = this.markets.get(mexcSymbol);
        if (!market) {
            return null;
        }

        const contractSize = Number(market.contractSize);
        const volUnit = Number(market.volUnit || 1);
        const minVol = Number(market.minVol || volUnit);
        if (!Number.isFinite(contractSize) || contractSize <= 0 || !Number.isFinite(volUnit) || volUnit <= 0) {
            return null;
        }

        const stepSize = volUnit * contractSize;
        const minQty = minVol * contractSize;
        const priceStep = Number(market.priceUnit || 0);

        return {
            symbol,
            minQty,
            stepSize,
            minNotional: 0,
            pricePrecision: priceStep > 0
                ? this.precisionFromStep(priceStep)
                : Math.max(0, Number(market.priceScale || 8)),
            quantityPrecision: this.precisionFromStep(stepSize),
        };
    }

    getUsdtSymbols(): string[] {
        return [...this.markets.keys()].map(symbol => mexcToUnified(symbol));
    }

    async pingPrivate(): Promise<void> {
        this.assertPrivateRequestsAllowed();
        await this.request('GET', '/api/v1/private/account/assets');
        await this.getPositionMode().catch((error: any) => {
            logger.warn(TAG, `MEXC position mode check failed: ${this.formatError(error)}`);
        });
    }

    async validateAccountMode(): Promise<void> {
        this.assertPrivateRequestsAllowed();
        const mode = await this.getPositionMode();
        if (mode !== 1 && mode !== 2) {
            throw new Error(`Unexpected MEXC position mode: ${mode}`);
        }
    }

    private async request<T>(
        method: HttpMethod,
        endpoint: string,
        params: Record<string, unknown> = {},
        data: unknown = null,
        signed = true,
    ): Promise<T> {
        const queryParams = method === 'GET' || method === 'DELETE'
            ? this.compactParams(params)
            : {};
        const queryString = this.buildQueryString(queryParams);
        const body = method === 'POST'
            ? JSON.stringify(this.compactParams(this.asRecord(data)))
            : '';
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (signed) {
            if (!this.apiKey || !this.secret) {
                throw new Error('MEXC API credentials are required for private futures requests');
            }

            const timestamp = Date.now().toString();
            const payloadToSign = method === 'POST' ? body : queryString;
            const signature = crypto
                .createHmac('sha256', this.secret)
                .update(`${this.apiKey}${timestamp}${payloadToSign}`)
                .digest('hex');

            headers.ApiKey = this.apiKey;
            headers['Request-Time'] = timestamp;
            headers.Signature = signature;
        }

        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        try {
            const response = await this.httpClient.request<MexcResponse<T> | T>({
                method,
                url,
                data: method === 'POST' ? body : undefined,
                headers,
            });

            return this.unwrapResponse<T>(response.data);
        } catch (error: any) {
            if (error instanceof MexcApiError) {
                throw error;
            }

            const responseData = error.response?.data;
            if (responseData && typeof responseData === 'object') {
                throw this.toApiError(responseData);
            }

            throw new Error(`MEXC HTTP Error: ${error.message}`);
        }
    }

    private unwrapResponse<T>(payload: MexcResponse<T> | T): T {
        if (
            payload
            && typeof payload === 'object'
            && 'success' in payload
            && 'code' in payload
        ) {
            const response = payload as MexcResponse<T>;
            if (response.success !== true || Number(response.code) !== 0) {
                throw this.toApiError(response);
            }

            return response.data;
        }

        return payload as T;
    }

    private toApiError(payload: Partial<MexcResponse<unknown>>): MexcApiError {
        const code = payload.code === undefined ? null : Number(payload.code);
        const message = payload.message || `MEXC API Error ${code ?? 'unknown'}`;
        return new MexcApiError(code, `MEXC API Error ${code ?? 'unknown'}: ${message}`, payload);
    }

    private async fetchNativePositions(mexcSymbol?: string): Promise<MexcPosition[]> {
        const params = mexcSymbol ? { symbol: mexcSymbol } : {};
        const data = await this.request<MexcPosition[] | MexcPosition>(
            'GET',
            '/api/v1/private/position/open_positions',
            params,
        );

        return Array.isArray(data) ? data : [data].filter(Boolean);
    }

    private normalizePosition(position: MexcPosition, expectedSymbol?: string): ExchangePosition | null {
        if (!position.symbol) {
            return null;
        }

        const symbol = expectedSymbol ?? mexcToUnified(position.symbol);
        if (expectedSymbol && unifiedToMexc(expectedSymbol) !== position.symbol) {
            return null;
        }

        const contracts = Math.abs(Number(position.holdVol || 0));
        if (!Number.isFinite(contracts) || contracts <= 0) {
            return null;
        }

        const contractSize = this.getContractSizeOrThrow(position.symbol, symbol);
        const amount = contracts * contractSize;

        return {
            symbol,
            contracts,
            amount,
            side: position.positionType === POSITION_TYPE_SHORT ? 'short' : 'long',
            entryPrice: Number(position.holdAvgPrice ?? position.openAvgPrice ?? 0),
            raw: position,
        };
    }

    private async changeLeverageForSide(
        mexcSymbol: string,
        positionType: number,
        leverage: number,
        existingPosition?: MexcPosition,
    ): Promise<void> {
        const payload: Record<string, unknown> = {
            leverage,
        };

        if (existingPosition?.positionId) {
            payload.positionId = existingPosition.positionId;
        } else {
            payload.symbol = mexcSymbol;
            payload.openType = ISOLATED_OPEN_TYPE;
            payload.positionType = positionType;
        }

        await this.request('POST', '/api/v1/private/position/change_leverage', {}, payload);
    }

    private async waitForOrderResult(
        mexcSymbol: string,
        orderId: string | undefined,
        externalOid: string,
        expectedBaseAmount: number,
        contractSize: number,
    ): Promise<OrderResult> {
        let lastOrder: MexcOrder | null = null;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.sleep(ORDER_POLL_DELAY_MS);
            }

            try {
                const order = orderId
                    ? await this.fetchOrder(orderId)
                    : await this.fetchOrderByExternalOid(mexcSymbol, externalOid);

                if (order) {
                    lastOrder = order;
                    if (this.isFinalOrder(order)) {
                        return this.buildOrderResult(order, expectedBaseAmount, contractSize);
                    }
                }
            } catch (error: any) {
                lastError = error;
                logger.warn(TAG, `MEXC order status query failed for ${orderId || externalOid}: ${this.formatError(error)}`);
            }
        }

        if (lastOrder) {
            return this.buildOrderResult(lastOrder, expectedBaseAmount, contractSize);
        }

        if (lastError) {
            throw new Error(`MEXC order ${orderId || externalOid} status could not be confirmed: ${this.formatError(lastError)}`);
        }

        throw new Error(`MEXC order ${orderId || externalOid} was not found after submission`);
    }

    private async reconcileSubmittedOrder(
        mexcSymbol: string,
        externalOid: string,
        expectedBaseAmount: number,
        contractSize: number,
    ): Promise<OrderResult | null> {
        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            await this.sleep(ORDER_POLL_DELAY_MS);
            try {
                const order = await this.fetchOrderByExternalOid(mexcSymbol, externalOid);
                if (order) {
                    return this.waitForOrderResult(
                        mexcSymbol,
                        order.orderId ? String(order.orderId) : undefined,
                        externalOid,
                        expectedBaseAmount,
                        contractSize,
                    );
                }
            } catch (error: any) {
                logger.warn(TAG, `MEXC order reconciliation failed for ${externalOid}: ${this.formatError(error)}`);
            }
        }

        return null;
    }

    private async fetchOrder(orderId: string): Promise<MexcOrder | null> {
        try {
            return await this.request<MexcOrder>('GET', `/api/v1/private/order/get/${encodeURIComponent(orderId)}`);
        } catch (error: any) {
            if (this.isOrderNotFound(error)) {
                return null;
            }

            throw error;
        }
    }

    private async fetchOrderByExternalOid(mexcSymbol: string, externalOid: string): Promise<MexcOrder | null> {
        try {
            return await this.request<MexcOrder>(
                'GET',
                `/api/v1/private/order/external/${encodeURIComponent(mexcSymbol)}/${encodeURIComponent(externalOid)}`,
            );
        } catch (error: any) {
            if (this.isOrderNotFound(error)) {
                return null;
            }

            throw error;
        }
    }

    private async buildOrderResult(
        order: MexcOrder,
        expectedBaseAmount: number,
        contractSize: number,
    ): Promise<OrderResult> {
        const orderId = String(order.orderId || order.externalOid || '');
        const deals = order.orderId ? await this.fetchOrderDeals(String(order.orderId)) : [];
        const dealStats = this.summarizeDeals(deals, contractSize);
        const orderFilledQty = Math.abs(Number(order.dealVol || 0)) * contractSize;
        const filledQty = dealStats.filledQty > 0 ? dealStats.filledQty : orderFilledQty;
        const avgPrice = dealStats.avgPrice || Number(order.dealAvgPrice || 0);
        const commission = dealStats.commission || this.extractOrderCommission(order);

        return {
            orderId,
            avgPrice,
            filledQty,
            commission,
            commissionAsset: 'USDT',
            status: this.normalizeOrderStatus(order, filledQty, expectedBaseAmount),
            raw: { order, deals },
        };
    }

    private async fetchOrderDeals(orderId: string): Promise<MexcDeal[]> {
        let lastError: unknown = null;

        for (let attempt = 0; attempt < DEAL_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.sleep(DEAL_POLL_DELAY_MS);
            }

            try {
                const deals = await this.request<MexcDeal[]>(
                    'GET',
                    `/api/v1/private/order/deal_details/${encodeURIComponent(orderId)}`,
                );

                if (Array.isArray(deals)) {
                    return deals;
                }
            } catch (error: any) {
                lastError = error;
            }
        }

        if (lastError) {
            logger.warn(TAG, `Failed to extract MEXC deals for order ${orderId}, fee left 0: ${this.formatError(lastError)}`);
        }

        return [];
    }

    private summarizeDeals(deals: MexcDeal[], contractSize: number): {
        filledQty: number;
        avgPrice: number;
        commission: number;
    } {
        let filledQty = 0;
        let notional = 0;
        let commission = 0;

        for (const deal of deals) {
            const baseQty = Math.abs(Number(deal.vol || 0)) * contractSize;
            const price = Number(deal.price || 0);
            filledQty += baseQty;
            notional += baseQty * price;

            const feeCurrency = String(deal.feeCurrency || SETTLE_COIN).toUpperCase();
            if (feeCurrency === 'USDT' || feeCurrency === 'USDC') {
                commission += Math.abs(Number(deal.fee || 0));
            }
        }

        return {
            filledQty,
            avgPrice: filledQty > 0 ? notional / filledQty : 0,
            commission,
        };
    }

    private extractOrderCommission(order: MexcOrder): number {
        return Math.abs(Number(order.takerFee || 0)) + Math.abs(Number(order.makerFee || 0));
    }

    private assertFilledMarketOrder(result: OrderResult, orderRef: string, expectedBaseAmount: number): void {
        const isFullFill = result.filledQty >= expectedBaseAmount * (1 - 1e-8);
        if (result.filledQty <= 0 || result.avgPrice <= 0 || result.status !== 'closed' || !isFullFill) {
            throw new Error(
                `MEXC market order ${orderRef} did not fully fill: status=${result.status}, filled=${result.filledQty}, requested=${expectedBaseAmount}, avgPrice=${result.avgPrice}`,
            );
        }
    }

    private normalizeOrderStatus(order: MexcOrder, filledQty: number, expectedBaseAmount: number): string {
        const isFullFill = filledQty >= expectedBaseAmount * (1 - 1e-8);
        if (order.state === 3 && isFullFill) {
            return 'closed';
        }

        if (order.state === 4) {
            return 'canceled';
        }

        if (order.state === 5) {
            return 'rejected';
        }

        if (order.state === 1 || order.state === 2) {
            return 'open';
        }

        return order.state === undefined ? 'unknown' : `state_${order.state}`;
    }

    private isFinalOrder(order: MexcOrder): boolean {
        return order.state === 3 || order.state === 4 || order.state === 5;
    }

    private isOrderNotFound(error: unknown): boolean {
        if (error instanceof MexcApiError && [2009, 2040, 600].includes(Number(error.code))) {
            return true;
        }

        const message = this.formatError(error).toLowerCase();
        return message.includes('not exist') || message.includes('not found');
    }

    private getOrderSide(side: 'buy' | 'sell', reduceOnly: boolean): number {
        if (reduceOnly) {
            return side === 'buy' ? 2 : 4;
        }

        return side === 'buy' ? 1 : 3;
    }

    private async getPositionModeForOrder(reduceOnly?: boolean): Promise<number | null> {
        try {
            return await this.getPositionMode();
        } catch (error: any) {
            if (reduceOnly) {
                logger.warn(TAG, `Could not confirm MEXC position mode before reduce-only close: ${this.formatError(error)}`);
            }
            return null;
        }
    }

    private async getPositionMode(): Promise<number> {
        if (this.positionMode !== null) {
            return this.positionMode;
        }

        const mode = await this.request<number>('GET', '/api/v1/private/position/position_mode');
        const numericMode = Number(mode);
        if (numericMode !== 1 && numericMode !== 2) {
            throw new Error(`Unexpected MEXC position mode: ${mode}`);
        }

        this.positionMode = numericMode;
        return numericMode;
    }

    private extractQuoteVolume(ticker: MexcTicker, last: number): number {
        const explicitQuoteVolume = Number(ticker.amount24 || 0);
        if (Number.isFinite(explicitQuoteVolume) && explicitQuoteVolume > 0) {
            return explicitQuoteVolume;
        }

        const contract = this.markets.get(ticker.symbol);
        const contractSize = Number(contract?.contractSize);
        const contractVolume = Number(ticker.volume24 || 0);
        if (
            Number.isFinite(contractVolume)
            && Number.isFinite(contractSize)
            && Number.isFinite(last)
            && contractVolume > 0
            && contractSize > 0
            && last > 0
        ) {
            return contractVolume * contractSize * last;
        }

        return 0;
    }

    private baseAmountToContracts(mexcSymbol: string, amount: number, contractSize: number): number {
        const market = this.markets.get(mexcSymbol);
        const volUnit = Number(market?.volUnit || 1);
        const minVol = Number(market?.minVol || volUnit);
        const maxVol = Number(market?.maxVol || Number.POSITIVE_INFINITY);
        const volScale = Math.max(0, Number(market?.volScale || 0));

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error(`MEXC order amount must be positive for ${mexcSymbol}: ${amount}`);
        }

        if (!Number.isFinite(volUnit) || volUnit <= 0) {
            throw new Error(`MEXC volUnit is missing for ${mexcSymbol}`);
        }

        const rawContracts = amount / contractSize;
        const roundedContracts = Math.floor((rawContracts / volUnit) + 1e-8) * volUnit;
        const normalized = Number(this.formatDecimal(roundedContracts, volScale));

        if (!Number.isFinite(normalized) || normalized < minVol) {
            throw new Error(`MEXC order volume for ${mexcSymbol} is below minimum: vol=${normalized}, minVol=${minVol}`);
        }

        if (normalized > maxVol) {
            throw new Error(`MEXC order volume for ${mexcSymbol} exceeds maximum: vol=${normalized}, maxVol=${maxVol}`);
        }

        const normalizedBaseAmount = normalized * contractSize;
        if (normalizedBaseAmount < amount * (1 - 1e-7)) {
            throw new Error(
                `MEXC base amount ${amount} is not aligned to ${mexcSymbol} contract size ${contractSize}; normalized amount would be ${normalizedBaseAmount}`,
            );
        }

        return normalized;
    }

    private getMarketOrThrow(mexcSymbol: string, symbol: string): MexcContract {
        const market = this.markets.get(mexcSymbol);
        if (!market) {
            throw new Error(`MEXC market metadata is missing for ${symbol}`);
        }

        return market;
    }

    private getContractSizeOrThrow(mexcSymbol: string, symbol: string): number {
        const market = this.getMarketOrThrow(mexcSymbol, symbol);
        const contractSize = Number(market.contractSize);
        if (!Number.isFinite(contractSize) || contractSize <= 0) {
            throw new Error(`MEXC contractSize is missing for ${symbol}`);
        }

        return contractSize;
    }

    private isTradeableUsdtContract(contract: MexcContract): boolean {
        const contractSize = Number(contract.contractSize);
        return contract.symbol.endsWith(`_${SETTLE_COIN}`)
            && contract.quoteCoin === SETTLE_COIN
            && contract.settleCoin === SETTLE_COIN
            && contract.state === 0
            && contract.apiAllowed !== false
            && Number.isFinite(contractSize)
            && contractSize > 0;
    }

    private assertPrivateRequestsAllowed(): void {
        if (this.useTestnet) {
            throw new Error('MEXC Contract API testnet is not configured in this project; disable use_testnet only after separate MEXC futures smoke checks.');
        }
    }

    private createExternalOid(clientOrderId?: string): string {
        if (clientOrderId) {
            const sanitized = clientOrderId.replace(/[^0-9A-Za-z_-]/g, '');
            if (sanitized.length > 0 && Buffer.byteLength(sanitized, 'utf8') <= 32) {
                return sanitized;
            }

            return `aa${crypto.createHash('sha256').update(clientOrderId).digest('hex').slice(0, 30)}`;
        }

        return `aa${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.slice(0, 32);
    }

    private compactParams(params: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
        );
    }

    private asRecord(value: unknown): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        return value as Record<string, unknown>;
    }

    private buildQueryString(params: Record<string, unknown>): string {
        return Object.keys(params)
            .sort()
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
            .join('&');
    }

    private precisionFromStep(step: string | number): number {
        const normalized = String(step).toLowerCase();
        if (normalized.includes('e-')) {
            return Number(normalized.split('e-')[1]);
        }

        const decimals = normalized.split('.')[1]?.replace(/0+$/, '');
        return decimals?.length ?? 0;
    }

    private formatDecimal(value: number, precision = 12): string {
        return Number(value).toFixed(precision).replace(/\.?0+$/, '');
    }

    private formatError(error: unknown): string {
        if (error instanceof MexcApiError) {
            return error.message;
        }

        return error instanceof Error ? error.message : String(error);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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

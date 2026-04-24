import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { ExchangeClientOptions, IExchangeClient } from './exchange-client.js';
import type { ExchangePosition, ExchangeTicker, OrderResult, SymbolMarketInfo } from '../types/index.js';
import { bybitToUnified, unifiedToBybit } from './symbols.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const TAG = 'BybitClient';
const CATEGORY = 'linear';
const SETTLE_COIN = 'USDT';
const RECV_WINDOW = '5000';
const ORDER_POLL_ATTEMPTS = 6;
const ORDER_POLL_DELAY_MS = 700;

type HttpMethod = 'GET' | 'POST';

interface BybitResponse<T> {
    retCode: number;
    retMsg: string;
    result: T;
    retExtInfo: unknown;
    time: number;
}

interface BybitListResult<T> {
    category?: string;
    list?: T[];
    nextPageCursor?: string;
}

interface BybitTimeResult {
    timeSecond?: string;
    timeNano?: string;
}

interface BybitInstrument {
    symbol: string;
    status?: string;
    contractType?: string;
    quoteCoin?: string;
    settleCoin?: string;
    priceScale?: string;
    priceFilter?: {
        tickSize?: string;
    };
    lotSizeFilter?: {
        minOrderQty?: string;
        qtyStep?: string;
        minNotionalValue?: string;
        maxMktOrderQty?: string;
    };
}

interface BybitTicker {
    symbol: string;
    lastPrice?: string;
    markPrice?: string;
    turnover24h?: string;
    volume24h?: string;
    fundingRate?: string;
    nextFundingTime?: string;
}

interface BybitPosition {
    symbol: string;
    side?: 'Buy' | 'Sell' | '';
    size?: string;
    avgPrice?: string;
    entryPrice?: string;
    positionIdx?: number;
}

interface BybitCreateOrderResult {
    orderId?: string;
    orderLinkId?: string;
}

interface BybitOrder {
    orderId?: string;
    orderLinkId?: string;
    symbol?: string;
    orderStatus?: string;
    avgPrice?: string;
    price?: string;
    qty?: string;
    cumExecQty?: string;
    cumExecValue?: string;
    cumExecFee?: string;
    cumFeeDetail?: Record<string, string>;
}

interface BybitExecution {
    orderId?: string;
    orderLinkId?: string;
    execPrice?: string;
    execQty?: string;
    execFee?: string;
    feeCurrency?: string;
}

class BybitApiError extends Error {
    constructor(
        public readonly code: number | null,
        message: string,
        public readonly raw?: unknown,
    ) {
        super(message);
        this.name = 'BybitApiError';
    }
}

/**
 * Bybit V5 native REST client for USDT linear perpetual contracts.
 *
 * The client signs requests directly, keeps the internal BTC/USDT:USDT symbol
 * contract, and avoids blind order retries. If an order request fails after it
 * may have reached Bybit, the code reconciles by orderLinkId before surfacing
 * an error to the trading loop.
 */
export class BybitClient implements IExchangeClient {
    public readonly name = 'Bybit';

    private readonly httpClient: AxiosInstance;
    private readonly apiKey: string;
    private readonly secret: string;
    private readonly markets: Map<string, BybitInstrument> = new Map();

    constructor(options: ExchangeClientOptions = {}) {
        const useTestnet = options.useTestnet ?? config.useTestnet;
        this.apiKey = options.apiKey ?? config.bybit.apiKey;
        this.secret = options.secret ?? config.bybit.secret;

        this.httpClient = axios.create({
            baseURL: useTestnet
                ? 'https://api-testnet.bybit.com'
                : 'https://api.bybit.com',
            timeout: 10000,
        });
    }

    async fetchTime(): Promise<number> {
        const result = await this.request<BybitTimeResult>('GET', '/v5/market/time');
        if (result.timeNano) {
            return Number(BigInt(result.timeNano) / 1_000_000n);
        }

        return Number(result.timeSecond || '0') * 1000;
    }

    async fetchTickers(symbols?: string[]): Promise<Record<string, ExchangeTicker>> {
        const requested = symbols ? new Set(symbols) : null;
        const params: Record<string, unknown> = { category: CATEGORY };

        if (symbols?.length === 1) {
            params.symbol = unifiedToBybit(symbols[0]);
        }

        const data = await this.request<BybitListResult<BybitTicker>>('GET', '/v5/market/tickers', params);
        const tickers: Record<string, ExchangeTicker> = {};

        for (const ticker of data.list ?? []) {
            const nativeSymbol = String(ticker.symbol);
            if (!nativeSymbol.endsWith(SETTLE_COIN)) {
                continue;
            }

            const symbol = bybitToUnified(nativeSymbol);
            if (requested && !requested.has(symbol)) {
                continue;
            }

            tickers[symbol] = {
                symbol,
                last: Number(ticker.lastPrice || ticker.markPrice || 0),
                quoteVolume: Number(ticker.turnover24h || 0),
                fundingRate: parseNullableNumber(ticker.fundingRate),
                nextFundingTime: parseNullableTimestamp(ticker.nextFundingTime),
                raw: ticker,
            };
        }

        return tickers;
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        if (symbols.length === 0) {
            return [];
        }

        const requested = new Set(symbols);
        const positions = symbols.length === 1
            ? await this.fetchPositionList({ category: CATEGORY, symbol: unifiedToBybit(symbols[0]) })
            : await this.fetchPositionList({ category: CATEGORY, settleCoin: SETTLE_COIN, limit: 200 });

        return positions
            .map(position => this.normalizePosition(position, requested))
            .filter((position): position is ExchangePosition => position !== null);
    }

    async loadMarkets(): Promise<void> {
        this.markets.clear();

        let cursor: string | undefined;
        do {
            const result = await this.request<BybitListResult<BybitInstrument>>(
                'GET',
                '/v5/market/instruments-info',
                {
                    category: CATEGORY,
                    limit: 1000,
                    ...(cursor ? { cursor } : {}),
                },
            );

            for (const instrument of result.list ?? []) {
                if (this.isTradeableUsdtPerpetual(instrument)) {
                    this.markets.set(instrument.symbol, instrument);
                }
            }

            cursor = result.nextPageCursor || undefined;
        } while (cursor);

        if (this.markets.size === 0) {
            throw new Error('Failed to load Bybit USDT perpetual markets');
        }

        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const bybitSymbol = unifiedToBybit(symbol);
        try {
            await this.request('POST', '/v5/position/set-leverage', {
                category: CATEGORY,
                symbol: bybitSymbol,
                buyLeverage: this.formatDecimal(leverage),
                sellLeverage: this.formatDecimal(leverage),
            }, true);
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
        } catch (error: any) {
            if (this.isIdempotentSetupError(error, [110043])) {
                logger.debug(TAG, `Leverage already ${leverage}x for ${symbol}`);
                return;
            }

            throw new Error(`Failed to set leverage to ${leverage}x on Bybit: ${this.formatError(error)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        const bybitSymbol = unifiedToBybit(symbol);
        const leverage = this.formatDecimal(config.leverage);

        try {
            await this.request('POST', '/v5/position/switch-isolated', {
                category: CATEGORY,
                symbol: bybitSymbol,
                tradeMode: 1,
                buyLeverage: leverage,
                sellLeverage: leverage,
            }, true);
            logger.debug(TAG, `Isolated margin set for ${symbol}`);
        } catch (error: any) {
            if (this.isIdempotentSetupError(error, [110026, 110043])) {
                logger.debug(TAG, `Margin already isolated for ${symbol}`);
                return;
            }

            throw new Error(`Failed to set isolated margin on Bybit: ${this.formatError(error)}`);
        }
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean; clientOrderId?: string } = {},
    ): Promise<OrderResult> {
        const bybitSymbol = unifiedToBybit(symbol);
        const orderLinkId = params.clientOrderId || this.createOrderLinkId();
        const qty = this.formatDecimal(amount, 16);

        logger.info(TAG, `Creating ${side} order for ${symbol}, amount: ${amount}`);

        const payload: Record<string, unknown> = {
            category: CATEGORY,
            symbol: bybitSymbol,
            side: side === 'buy' ? 'Buy' : 'Sell',
            orderType: 'Market',
            qty,
            timeInForce: 'IOC',
            orderLinkId,
            positionIdx: 0,
        };

        if (params.reduceOnly) {
            payload.reduceOnly = true;
        }

        let createResult: BybitCreateOrderResult;
        try {
            createResult = await this.request<BybitCreateOrderResult>('POST', '/v5/order/create', payload, true);
        } catch (error: any) {
            if (!(error instanceof BybitApiError)) {
                const reconciled = await this.reconcileSubmittedOrder(symbol, orderLinkId, amount);
                if (reconciled) {
                    this.assertFilledMarketOrder(reconciled, orderLinkId, amount);
                    logger.info(TAG, `Order filled after reconciliation: ${symbol} ${side} @ ${reconciled.avgPrice}, qty: ${reconciled.filledQty}, commission: ${reconciled.commission} USDT`);
                    return reconciled;
                }
            }

            throw new Error(`Bybit order failed: ${this.formatError(error)}`);
        }

        const orderId = createResult.orderId ? String(createResult.orderId) : undefined;
        const result = await this.waitForOrderResult(symbol, orderId, orderLinkId, amount);

        this.assertFilledMarketOrder(result, orderId || orderLinkId, amount);
        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const bybitSymbol = unifiedToBybit(symbol);
        const market = this.markets.get(bybitSymbol);
        if (!market) {
            return null;
        }

        const qtyStep = market.lotSizeFilter?.qtyStep || '0.001';
        const tickSize = market.priceFilter?.tickSize || '0.001';

        return {
            symbol,
            minQty: Number(market.lotSizeFilter?.minOrderQty || 0),
            stepSize: Number(qtyStep),
            minNotional: Number(market.lotSizeFilter?.minNotionalValue || 0),
            pricePrecision: this.precisionFromStep(tickSize),
            quantityPrecision: this.precisionFromStep(qtyStep),
        };
    }

    getUsdtSymbols(): string[] {
        return [...this.markets.keys()].map(symbol => bybitToUnified(symbol));
    }

    async pingPrivate(): Promise<void> {
        await this.request('GET', '/v5/position/list', {
            category: CATEGORY,
            settleCoin: SETTLE_COIN,
            limit: 1,
        }, true);
    }

    async validateAccountMode(): Promise<void> {
        const data = await this.request<BybitListResult<BybitPosition>>('GET', '/v5/position/list', {
            category: CATEGORY,
            settleCoin: SETTLE_COIN,
            limit: 20,
        }, true);

        const hedgePosition = (data.list ?? []).find(position => Number(position.positionIdx || 0) !== 0);
        if (hedgePosition) {
            throw new Error('Bybit hedge position mode is detected; trader requires one-way position mode.');
        }
    }

    private async request<T>(
        method: HttpMethod,
        endpoint: string,
        params: Record<string, unknown> = {},
        auth: boolean = false,
    ): Promise<T> {
        const compactParams = this.compactParams(params);
        const queryString = this.toQueryString(compactParams);
        const body = method === 'POST' ? JSON.stringify(compactParams) : '';
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        let url = endpoint;
        if (method === 'GET' && queryString) {
            url = `${endpoint}?${queryString}`;
        }

        if (auth) {
            if (!this.apiKey || !this.secret) {
                throw new Error('Bybit API credentials are required for private endpoints');
            }

            const timestamp = Date.now().toString();
            const payloadToSign = method === 'GET' ? queryString : body;
            const signature = crypto
                .createHmac('sha256', this.secret)
                .update(`${timestamp}${this.apiKey}${RECV_WINDOW}${payloadToSign}`)
                .digest('hex');

            headers['X-BAPI-API-KEY'] = this.apiKey;
            headers['X-BAPI-TIMESTAMP'] = timestamp;
            headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
            headers['X-BAPI-SIGN'] = signature;
        }

        try {
            const response = await this.httpClient.request<BybitResponse<T>>({
                method,
                url,
                data: method === 'POST' ? body : undefined,
                headers,
            });

            if (response.data.retCode !== 0) {
                throw new BybitApiError(
                    response.data.retCode,
                    `Bybit API Error ${response.data.retCode}: ${response.data.retMsg}`,
                    response.data,
                );
            }

            return response.data.result;
        } catch (error: any) {
            if (error instanceof BybitApiError) {
                throw error;
            }

            const responseData = error.response?.data as Partial<BybitResponse<unknown>> | undefined;
            if (responseData?.retCode !== undefined) {
                throw new BybitApiError(
                    Number(responseData.retCode),
                    `Bybit API Error ${responseData.retCode}: ${responseData.retMsg || error.message}`,
                    responseData,
                );
            }

            throw new Error(`Bybit HTTP Error: ${error.message}`);
        }
    }

    private async fetchPositionList(params: Record<string, unknown>): Promise<BybitPosition[]> {
        const positions: BybitPosition[] = [];
        let cursor: string | undefined;

        do {
            const result = await this.request<BybitListResult<BybitPosition>>(
                'GET',
                '/v5/position/list',
                {
                    ...params,
                    ...(cursor ? { cursor } : {}),
                },
                true,
            );

            positions.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);

        return positions;
    }

    private normalizePosition(position: BybitPosition, requested: Set<string>): ExchangePosition | null {
        if (!position.symbol?.endsWith(SETTLE_COIN)) {
            return null;
        }

        const symbol = bybitToUnified(position.symbol);
        if (!requested.has(symbol)) {
            return null;
        }

        const amount = Math.abs(Number(position.size || 0));
        if (amount <= 0 || !position.side) {
            return null;
        }

        return {
            symbol,
            contracts: amount,
            amount,
            side: position.side === 'Sell' ? 'short' : 'long',
            entryPrice: Number(position.avgPrice || position.entryPrice || 0),
            raw: position,
        };
    }

    private async waitForOrderResult(
        symbol: string,
        orderId: string | undefined,
        orderLinkId: string,
        requestedAmount: number,
    ): Promise<OrderResult> {
        let lastOrder: BybitOrder | null = null;
        let lastQueryError: unknown = null;

        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.sleep(ORDER_POLL_DELAY_MS);
            }

            let order: BybitOrder | null = null;
            try {
                order = await this.fetchOrder(symbol, orderId, orderLinkId);
            } catch (error: any) {
                lastQueryError = error;
                logger.warn(TAG, `Bybit order status query failed for ${orderId || orderLinkId}: ${this.formatError(error)}`);
                continue;
            }

            if (!order) {
                continue;
            }

            lastOrder = order;
            if (order.orderStatus === 'Filled') {
                return this.buildOrderResult(symbol, order, requestedAmount);
            }
        }

        if (lastOrder) {
            return this.buildOrderResult(symbol, lastOrder, requestedAmount);
        }

        try {
            const executions = await this.fetchExecutions(symbol, orderId, orderLinkId);
            if (executions.length > 0) {
                return this.buildExecutionOnlyResult(symbol, orderId, orderLinkId, requestedAmount, executions);
            }
        } catch (error: any) {
            lastQueryError = error;
        }

        if (lastQueryError) {
            throw new Error(`Bybit order ${orderId || orderLinkId} status could not be confirmed: ${this.formatError(lastQueryError)}`);
        }

        throw new Error(`Bybit order ${orderId || orderLinkId} was not found after submission`);
    }

    private async reconcileSubmittedOrder(
        symbol: string,
        orderLinkId: string,
        requestedAmount: number,
    ): Promise<OrderResult | null> {
        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            await this.sleep(ORDER_POLL_DELAY_MS);
            try {
                const order = await this.fetchOrder(symbol, undefined, orderLinkId);
                if (order) {
                    return this.waitForOrderResult(symbol, order.orderId, orderLinkId, requestedAmount);
                }
            } catch (error: any) {
                logger.warn(TAG, `Bybit order reconciliation failed for ${orderLinkId}: ${this.formatError(error)}`);
            }
        }

        return null;
    }

    private async fetchOrder(
        symbol: string,
        orderId: string | undefined,
        orderLinkId: string,
    ): Promise<BybitOrder | null> {
        const realtime = await this.fetchOrderFromEndpoint('/v5/order/realtime', symbol, orderId, orderLinkId);
        if (realtime) {
            return realtime;
        }

        return this.fetchOrderFromEndpoint('/v5/order/history', symbol, orderId, orderLinkId);
    }

    private async fetchOrderFromEndpoint(
        endpoint: string,
        symbol: string,
        orderId: string | undefined,
        orderLinkId: string,
    ): Promise<BybitOrder | null> {
        const result = await this.request<BybitListResult<BybitOrder>>(
            'GET',
            endpoint,
            {
                category: CATEGORY,
                symbol: unifiedToBybit(symbol),
                ...(orderId ? { orderId } : { orderLinkId }),
                ...(endpoint.endsWith('/realtime') ? { openOnly: 1 } : {}),
                limit: 1,
            },
            true,
        );

        return result.list?.[0] ?? null;
    }

    private async fetchExecutions(
        symbol: string,
        orderId: string | undefined,
        orderLinkId: string,
    ): Promise<BybitExecution[]> {
        const executions: BybitExecution[] = [];
        let cursor: string | undefined;

        do {
            const result = await this.request<BybitListResult<BybitExecution>>(
                'GET',
                '/v5/execution/list',
                {
                    category: CATEGORY,
                    symbol: unifiedToBybit(symbol),
                    ...(orderId ? { orderId } : { orderLinkId }),
                    limit: 100,
                    ...(cursor ? { cursor } : {}),
                },
                true,
            );

            executions.push(...(result.list ?? []));
            cursor = result.nextPageCursor || undefined;
        } while (cursor);

        return executions;
    }

    private async buildOrderResult(
        symbol: string,
        order: BybitOrder,
        requestedAmount: number,
    ): Promise<OrderResult> {
        let executions: BybitExecution[] = [];
        try {
            executions = await this.fetchExecutions(symbol, order.orderId, order.orderLinkId || '');
        } catch (error: any) {
            logger.warn(TAG, `Failed to fetch executions for Bybit order ${order.orderId || order.orderLinkId}: ${this.formatError(error)}`);
        }

        const executionStats = this.summarizeExecutions(executions);
        const orderQty = Number(order.cumExecQty || 0);
        const orderValue = Number(order.cumExecValue || 0);
        const orderAvg = Number(order.avgPrice || 0) || (orderQty > 0 ? orderValue / orderQty : 0);
        const commission = executionStats.commission || this.extractCommissionFromOrder(order);
        const filledQty = executionStats.filledQty || orderQty;

        return {
            orderId: String(order.orderId || order.orderLinkId || ''),
            avgPrice: executionStats.avgPrice || orderAvg,
            filledQty,
            commission,
            commissionAsset: 'USDT',
            status: this.normalizeOrderStatus(order.orderStatus),
            raw: { order, executions },
        };
    }

    private buildExecutionOnlyResult(
        symbol: string,
        orderId: string | undefined,
        orderLinkId: string,
        requestedAmount: number,
        executions: BybitExecution[],
    ): OrderResult {
        const executionStats = this.summarizeExecutions(executions);
        const isFullFill = executionStats.filledQty >= requestedAmount * (1 - 1e-8);

        return {
            orderId: orderId || orderLinkId,
            avgPrice: executionStats.avgPrice,
            filledQty: executionStats.filledQty,
            commission: executionStats.commission,
            commissionAsset: 'USDT',
            status: isFullFill ? 'closed' : 'open',
            raw: { symbol, executions },
        };
    }

    private summarizeExecutions(executions: BybitExecution[]): {
        filledQty: number;
        avgPrice: number;
        commission: number;
    } {
        let filledQty = 0;
        let notional = 0;
        let commission = 0;

        for (const execution of executions) {
            const qty = Number(execution.execQty || 0);
            const price = Number(execution.execPrice || 0);
            filledQty += qty;
            notional += qty * price;

            const feeCurrency = String(execution.feeCurrency || SETTLE_COIN).toUpperCase();
            if (feeCurrency === 'USDT' || feeCurrency === 'USDC') {
                commission += Math.abs(Number(execution.execFee || 0));
            }
        }

        return {
            filledQty,
            avgPrice: filledQty > 0 ? notional / filledQty : 0,
            commission,
        };
    }

    private extractCommissionFromOrder(order: BybitOrder): number {
        if (order.cumFeeDetail) {
            return Object.entries(order.cumFeeDetail).reduce((total, [currency, value]) => {
                if (['USDT', 'USDC'].includes(currency.toUpperCase())) {
                    return total + Math.abs(Number(value || 0));
                }

                return total;
            }, 0);
        }

        return Math.abs(Number(order.cumExecFee || 0));
    }

    private normalizeOrderStatus(status: string | undefined): string {
        switch (status) {
            case 'Filled':
                return 'closed';
            case 'Cancelled':
            case 'PartiallyFilledCanceled':
                return 'canceled';
            case 'Rejected':
                return 'rejected';
            case 'New':
            case 'PartiallyFilled':
                return 'open';
            default:
                return status?.toLowerCase() || 'unknown';
        }
    }

    private assertFilledMarketOrder(result: OrderResult, orderRef: string, requestedAmount: number): void {
        const isFullFill = result.filledQty >= requestedAmount * (1 - 1e-8);
        if (result.filledQty <= 0 || result.status !== 'closed' || !isFullFill) {
            throw new Error(
                `Bybit market order ${orderRef} did not fully fill: status=${result.status}, filled=${result.filledQty}, requested=${requestedAmount}`,
            );
        }
    }

    private isTradeableUsdtPerpetual(instrument: BybitInstrument): boolean {
        return instrument.symbol.endsWith(SETTLE_COIN)
            && instrument.quoteCoin === SETTLE_COIN
            && instrument.settleCoin === SETTLE_COIN
            && instrument.status === 'Trading'
            && instrument.contractType === 'LinearPerpetual';
    }

    private compactParams(params: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
        );
    }

    private toQueryString(params: Record<string, unknown>): string {
        return Object.keys(params)
            .sort()
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
            .join('&');
    }

    private createOrderLinkId(): string {
        return `aa_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
    }

    private isIdempotentSetupError(error: unknown, codes: number[]): boolean {
        if (error instanceof BybitApiError && error.code !== null && codes.includes(error.code)) {
            return true;
        }

        const message = error instanceof Error ? error.message.toLowerCase() : '';
        return message.includes('not modified') || message.includes('same');
    }

    private formatDecimal(value: number, maxDecimals: number = 12): string {
        return Number(value).toFixed(maxDecimals).replace(/\.?0+$/, '');
    }

    private precisionFromStep(step: string | number): number {
        const normalized = String(step).toLowerCase();
        if (normalized.includes('e-')) {
            return Number(normalized.split('e-')[1]);
        }

        const decimals = normalized.split('.')[1]?.replace(/0+$/, '');
        return decimals?.length ?? 0;
    }

    private formatError(error: unknown): string {
        if (error instanceof BybitApiError) {
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

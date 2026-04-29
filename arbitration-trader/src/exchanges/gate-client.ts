import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type { ExchangeClientOptions, IExchangeClient } from './exchange-client.js';
import type { ExchangePosition, ExchangeTicker, MarketOrderSubmission, OrderResult, SymbolMarketInfo } from '../types/index.js';
import { gateToUnified, unifiedToGate } from './symbols.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { decimalPlaces } from '../utils/math.js';

const TAG = 'GateClient';
const SETTLE = 'usdt';
const ORDER_POLL_ATTEMPTS = 6;
const ORDER_POLL_DELAY_MS = 700;
const TRADE_POLL_ATTEMPTS = 3;
const TRADE_POLL_DELAY_MS = 500;

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface GateContract {
    name: string;
    type?: string;
    quanto_multiplier?: string | number;
    order_price_round?: string | number;
    order_size_round?: string | number;
    order_size_min?: string | number;
}

interface GateTicker {
    contract: string;
    last?: string;
    mark_price?: string;
    volume_24h_quote?: string;
    funding_rate?: string;
    funding_rate_indicative?: string;
    funding_next_apply?: string | number;
}

interface GatePosition {
    contract?: string;
    size?: string | number;
    leverage?: string | number;
    lever?: string | number;
    pos_margin_mode?: string;
    entry_price?: string;
}

interface GateOrder {
    id?: string | number;
    contract?: string;
    size?: string | number;
    left?: string | number;
    fill_price?: string | number;
    status?: string;
    finish_as?: string;
    text?: string;
}

interface GateTrade {
    size?: string | number;
    price?: string | number;
    fee?: string | number;
}

/**
 * Gate USDT futures REST client.
 *
 * Gate uses contract sizes rather than raw base-coin amounts for order payloads,
 * so this adapter performs explicit conversion through quanto_multiplier.
 */
export class GateClient implements IExchangeClient {
    public readonly name = 'Gate';

    private readonly httpClient: AxiosInstance;
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly secret: string;
    private readonly markets: Map<string, GateContract> = new Map();

    constructor(options: ExchangeClientOptions = {}) {
        const useTestnet = options.useTestnet ?? config.useTestnet;
        this.apiKey = options.apiKey ?? config.gate.apiKey;
        this.secret = options.secret ?? config.gate.secret;

        this.baseUrl = useTestnet
            ? 'https://fx-api-testnet.gateio.ws/api/v4'
            : 'https://fx-api.gateio.ws/api/v4';

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: 10000,
        });
    }

    async fetchTime(): Promise<number> {
        return Date.now();
    }

    async fetchTickers(symbols?: string[]): Promise<Record<string, ExchangeTicker>> {
        const requested = symbols ? new Set(symbols) : null;
        const data = await this.request<GateTicker[]>('GET', `/futures/${SETTLE}/tickers`, {}, null, false);
        const tickers: Record<string, ExchangeTicker> = {};

        for (const ticker of data) {
            const symbol = gateToUnified(ticker.contract);
            if (requested && !requested.has(symbol)) {
                continue;
            }

            tickers[symbol] = {
                symbol,
                last: Number(ticker.last || ticker.mark_price || 0),
                quoteVolume: Number(ticker.volume_24h_quote || 0),
                fundingRate: parseNullableNumber(ticker.funding_rate || ticker.funding_rate_indicative),
                nextFundingTime: parseNullableTimestamp(ticker.funding_next_apply),
                raw: ticker,
            };
        }

        return tickers;
    }

    async fetchPositions(symbols: string[]): Promise<ExchangePosition[]> {
        const results: ExchangePosition[] = [];

        for (const symbol of symbols) {
            try {
                const gateSymbol = unifiedToGate(symbol);
                const data = await this.request<GatePosition>('GET', `/futures/${SETTLE}/positions/${gateSymbol}`);
                const position = this.normalizePosition(data, symbol);
                if (!position) {
                    continue;
                }

                results.push(position);
            } catch (error: any) {
                const message = this.formatError(error);
                logger.error(TAG, `Failed to fetch positions for ${symbol}: ${message}`);
                throw new Error(`Failed to fetch Gate position for ${symbol}: ${message}`);
            }
        }

        return results;
    }

    async fetchAllOpenPositions(): Promise<ExchangePosition[]> {
        const data = await this.request<GatePosition[]>('GET', `/futures/${SETTLE}/positions`);
        return data
            .map(position => this.normalizePosition(position))
            .filter((position): position is ExchangePosition => position !== null);
    }

    async pingPrivate(): Promise<void> {
        await this.request('GET', `/futures/${SETTLE}/accounts`);
    }

    async validateAccountMode(): Promise<void> {
        await this.pingPrivate();
    }

    async loadMarkets(): Promise<void> {
        const contracts = await this.request<GateContract[]>('GET', `/futures/${SETTLE}/contracts`, {}, null, false);
        this.markets.clear();

        for (const contract of contracts) {
            if (this.isTradeableUsdtContract(contract)) {
                this.markets.set(contract.name, contract);
            }
        }

        if (this.markets.size === 0) {
            throw new Error('Failed to load Gate USDT futures markets');
        }

        logger.info(TAG, `Markets loaded: ${this.markets.size} symbols`);
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const gateSymbol = unifiedToGate(symbol);
        try {
            const response = await this.request<GatePosition>(
                'POST',
                `/futures/${SETTLE}/positions/${gateSymbol}/leverage`,
                { leverage: this.formatDecimal(leverage) },
            );

            this.assertIsolatedLeverage(symbol, leverage, response);
            logger.debug(TAG, `Isolated leverage set to ${leverage}x for ${symbol}`);
        } catch (error: any) {
            throw new Error(`Failed to set isolated leverage to ${leverage}x on Gate for ${symbol}: ${this.formatError(error)}`);
        }
    }

    async setIsolatedMargin(symbol: string): Promise<void> {
        if (!Number.isFinite(config.leverage) || config.leverage <= 0) {
            throw new Error(`Gate isolated margin requires a positive leverage for ${symbol}`);
        }

        // Gate uses positive leverage as isolated margin mode. Runtime calls
        // setLeverage immediately after this method, where the API response is
        // validated before the symbol is allowed into scanning.
        logger.debug(TAG, `Gate isolated margin for ${symbol} is controlled by positive leverage.`);
    }

    async createMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean; clientOrderId?: string } = {},
    ): Promise<OrderResult> {
        const submission = await this.submitMarketOrder(symbol, side, amount, params);
        const result = await this.confirmOrderResult(submission);
        this.assertFilledMarketOrder(result, submission.orderId || submission.clientOrderId, submission.amount);
        logger.info(TAG, `Order filled: ${symbol} ${side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`);
        return result;
    }

    async submitMarketOrder(
        symbol: string,
        side: 'buy' | 'sell',
        amount: number,
        params: { reduceOnly?: boolean; clientOrderId?: string } = {},
    ): Promise<MarketOrderSubmission> {
        const gateSymbol = unifiedToGate(symbol);
        const multiplier = this.getMultiplierOrThrow(gateSymbol, symbol);
        const sizeInContracts = this.baseAmountToContracts(gateSymbol, amount, multiplier);
        const signedSize = side === 'sell' ? -sizeInContracts : sizeInContracts;
        const clientText = this.createOrderText(params.clientOrderId);

        logger.info(TAG, `Submitting ${side} order for ${symbol}, amount (base): ${amount}, size (contracts): ${signedSize}`);

        const payload: Record<string, unknown> = {
            contract: gateSymbol,
            size: Number(this.formatDecimal(signedSize, 16)),
            price: '0',
            tif: 'ioc',
            text: clientText,
        };

        if (params.reduceOnly) {
            payload.reduce_only = true;
        }

        let orderData: GateOrder;
        const submittedAtMs = Date.now();
        try {
            orderData = await this.request<GateOrder>('POST', `/futures/${SETTLE}/orders`, {}, payload);
        } catch (error: any) {
            const reconciled = await this.reconcileSubmittedOrderAck(
                gateSymbol,
                symbol,
                clientText,
                side,
                amount,
                Boolean(params.reduceOnly),
                submittedAtMs,
            );
            if (reconciled) {
                return reconciled;
            }

            throw new Error(`Gate order failed: ${this.formatError(error)}`);
        }

        const orderId = orderData.id ? String(orderData.id) : undefined;
        return {
            symbol,
            side,
            amount,
            reduceOnly: Boolean(params.reduceOnly),
            orderId,
            clientOrderId: clientText,
            submittedAtMs,
            acknowledgedAtMs: Date.now(),
            raw: orderData,
        };
    }

    async confirmOrderResult(submission: MarketOrderSubmission): Promise<OrderResult> {
        const gateSymbol = unifiedToGate(submission.symbol);
        const multiplier = this.getMultiplierOrThrow(gateSymbol, submission.symbol);
        const initialOrder = isGateOrder(submission.raw) ? submission.raw : undefined;
        const result = await this.waitForOrderResult(
            gateSymbol,
            submission.orderId,
            submission.clientOrderId,
            submission.amount,
            multiplier,
            initialOrder,
        );
        logger.info(
            TAG,
            `Order confirmed: ${submission.symbol} ${submission.side} @ ${result.avgPrice}, qty: ${result.filledQty}, commission: ${result.commission} USDT`,
        );
        return result;
    }

    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const gateSymbol = unifiedToGate(symbol);
        const market = this.markets.get(gateSymbol);
        if (!market) {
            return null;
        }

        const quantoMultiplier = Number(market.quanto_multiplier);
        if (!Number.isFinite(quantoMultiplier) || quantoMultiplier <= 0) {
            return null;
        }

        const priceStep = Number(market.order_price_round || 0);
        const sizeStepContracts = Number(market.order_size_round || 1);
        const stepSizeBase = sizeStepContracts * quantoMultiplier;
        const minQtyContracts = Number(market.order_size_min || 1);
        const minQtyBase = minQtyContracts * quantoMultiplier;

        if (!Number.isFinite(stepSizeBase) || stepSizeBase <= 0 || !Number.isFinite(minQtyBase) || minQtyBase <= 0) {
            return null;
        }

        return {
            symbol,
            minQty: minQtyBase,
            stepSize: stepSizeBase,
            minNotional: 0,
            pricePrecision: priceStep > 0 ? decimalPlaces(priceStep) : 8,
            quantityPrecision: decimalPlaces(stepSizeBase),
        };
    }

    getUsdtSymbols(): string[] {
        const symbols: string[] = [];
        for (const contract of this.markets.values()) {
            symbols.push(gateToUnified(contract.name));
        }
        return symbols;
    }

    private normalizePosition(position: GatePosition, expectedSymbol?: string): ExchangePosition | null {
        const gateSymbol = position.contract;
        if (!gateSymbol) {
            return null;
        }

        const symbol = expectedSymbol ?? gateToUnified(gateSymbol);
        if (expectedSymbol && unifiedToGate(expectedSymbol) !== gateSymbol) {
            return null;
        }

        const nativeSize = Number(position.size || 0);
        if (!Number.isFinite(nativeSize) || nativeSize === 0) {
            return null;
        }

        const multiplier = this.getMultiplierOrThrow(gateSymbol, symbol);
        const baseAmount = Math.abs(nativeSize) * multiplier;

        return {
            symbol,
            // Trader closes positions with `contracts ?? amount`, so both fields
            // intentionally carry base amount for Gate.
            contracts: baseAmount,
            amount: baseAmount,
            side: nativeSize > 0 ? 'long' : 'short',
            entryPrice: Number(position.entry_price || 0),
            raw: position,
        };
    }

    private sign(method: string, endpoint: string, query: string, payload: string): Record<string, string> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const hashedPayload = crypto.createHash('sha512').update(payload).digest('hex');
        const signatureString = [method, endpoint, query, hashedPayload, timestamp].join('\n');
        const signature = crypto.createHmac('sha512', this.secret).update(signatureString).digest('hex');

        return {
            KEY: this.apiKey,
            Timestamp: timestamp,
            SIGN: signature,
        };
    }

    private async request<T = unknown>(
        method: HttpMethod,
        endpoint: string,
        query: Record<string, unknown> = {},
        data: unknown = null,
        signed = true,
    ): Promise<T> {
        const queryString = this.buildQueryString(query);
        const payload = data === null || data === undefined ? '' : JSON.stringify(data);
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        };

        if (signed) {
            if (!this.apiKey || !this.secret) {
                throw new Error('Gate API credentials are required for private futures requests');
            }
            Object.assign(headers, this.sign(method, `/api/v4${endpoint}`, queryString, payload));
        }

        const url = queryString ? `${endpoint}?${queryString}` : endpoint;

        try {
            const response = await this.httpClient.request({
                method,
                url,
                data: payload || undefined,
                headers,
            });
            return response.data as T;
        } catch (error: any) {
            throw this.normalizeRequestError(error);
        }
    }

    private async waitForOrderResult(
        gateSymbol: string,
        orderId: string | undefined,
        clientText: string,
        requestedAmount: number,
        multiplier: number,
        initialOrder?: GateOrder,
    ): Promise<OrderResult> {
        let lastOrder: GateOrder | null = initialOrder ?? null;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.sleep(ORDER_POLL_DELAY_MS);
            }

            try {
                const order = orderId
                    ? await this.fetchOrder(orderId)
                    : await this.findOrderByText(gateSymbol, clientText);
                if (order) {
                    lastOrder = order;
                    if (this.isFinalOrder(order)) {
                        return this.buildOrderResult(gateSymbol, order, requestedAmount, multiplier);
                    }
                }
            } catch (error: any) {
                lastError = error;
                logger.warn(TAG, `Gate order status query failed for ${orderId || clientText}: ${this.formatError(error)}`);
            }
        }

        if (lastOrder) {
            return this.buildOrderResult(gateSymbol, lastOrder, requestedAmount, multiplier);
        }

        if (lastError) {
            throw new Error(`Gate order ${orderId || clientText} status could not be confirmed: ${this.formatError(lastError)}`);
        }

        throw new Error(`Gate order ${orderId || clientText} was not found after submission`);
    }

    private async reconcileSubmittedOrderAck(
        gateSymbol: string,
        symbol: string,
        clientText: string,
        side: 'buy' | 'sell',
        amount: number,
        reduceOnly: boolean,
        submittedAtMs: number,
    ): Promise<MarketOrderSubmission | null> {
        for (let attempt = 0; attempt < ORDER_POLL_ATTEMPTS; attempt++) {
            await this.sleep(ORDER_POLL_DELAY_MS);
            try {
                const order = await this.findOrderByText(gateSymbol, clientText);
                if (order) {
                    return {
                        symbol,
                        side,
                        amount,
                        reduceOnly,
                        orderId: order.id ? String(order.id) : undefined,
                        clientOrderId: clientText,
                        submittedAtMs,
                        acknowledgedAtMs: Date.now(),
                        raw: { order, reconciled: true },
                    };
                }
            } catch (error: any) {
                logger.warn(TAG, `Gate order reconciliation failed for ${clientText}: ${this.formatError(error)}`);
            }
        }

        return null;
    }

    private async fetchOrder(orderId: string): Promise<GateOrder | null> {
        try {
            return await this.request<GateOrder>('GET', `/futures/${SETTLE}/orders/${orderId}`);
        } catch (error: any) {
            if (this.formatError(error).toLowerCase().includes('order_not_found')) {
                return null;
            }
            throw error;
        }
    }

    private async findOrderByText(gateSymbol: string, clientText: string): Promise<GateOrder | null> {
        for (const status of ['open', 'finished']) {
            const orders = await this.request<GateOrder[]>('GET', `/futures/${SETTLE}/orders`, {
                contract: gateSymbol,
                status,
                limit: 100,
            });

            const matched = orders.find(order => order.text === clientText);
            if (matched) {
                return matched;
            }
        }

        return null;
    }

    private async buildOrderResult(
        gateSymbol: string,
        order: GateOrder,
        requestedAmount: number,
        multiplier: number,
    ): Promise<OrderResult> {
        const trades = order.id ? await this.fetchOrderTrades(gateSymbol, String(order.id), multiplier) : [];
        const tradeStats = this.summarizeTrades(trades, multiplier);

        const orderSize = Math.abs(Number(order.size || 0));
        const orderLeft = Math.abs(Number(order.left || 0));
        const filledContracts = Math.max(0, orderSize - orderLeft);
        const orderFilledQty = filledContracts * multiplier;
        const filledQty = tradeStats.filledQty > 0 ? tradeStats.filledQty : orderFilledQty;
        const avgPrice = Number(order.fill_price || 0) || tradeStats.avgPrice;

        return {
            orderId: String(order.id || order.text || ''),
            avgPrice,
            filledQty,
            commission: tradeStats.commission,
            commissionAsset: 'USDT',
            status: this.normalizeOrderStatus(order, filledQty, requestedAmount),
            raw: { order, trades },
        };
    }

    private async fetchOrderTrades(gateSymbol: string, orderId: string, multiplier: number): Promise<GateTrade[]> {
        let lastError: unknown = null;

        for (let attempt = 0; attempt < TRADE_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                await this.sleep(TRADE_POLL_DELAY_MS);
            }

            try {
                const trades = await this.request<GateTrade[]>('GET', `/futures/${SETTLE}/my_trades`, {
                    contract: gateSymbol,
                    order: orderId,
                });

                if (Array.isArray(trades)) {
                    return trades;
                }
            } catch (error: any) {
                lastError = error;
            }
        }

        if (lastError) {
            logger.warn(TAG, `Failed to extract Gate trades for order ${orderId}, fee left 0: ${this.formatError(lastError)}`);
        }

        return [];
    }

    private summarizeTrades(trades: GateTrade[], multiplier: number): {
        filledQty: number;
        avgPrice: number;
        commission: number;
    } {
        let filledQty = 0;
        let notional = 0;
        let commission = 0;

        for (const trade of trades) {
            const baseQty = Math.abs(Number(trade.size || 0)) * multiplier;
            const price = Number(trade.price || 0);
            filledQty += baseQty;
            notional += baseQty * price;
            commission += Math.abs(Number(trade.fee || 0));
        }

        return {
            filledQty,
            avgPrice: filledQty > 0 ? notional / filledQty : 0,
            commission,
        };
    }

    private assertFilledMarketOrder(result: OrderResult, orderRef: string, requestedAmount: number): void {
        const isFullFill = result.filledQty >= requestedAmount * (1 - 1e-8);
        if (result.filledQty <= 0 || result.avgPrice <= 0 || result.status !== 'closed' || !isFullFill) {
            throw new Error(
                `Gate market order ${orderRef} did not fully fill: status=${result.status}, filled=${result.filledQty}, requested=${requestedAmount}, avgPrice=${result.avgPrice}`,
            );
        }
    }

    private normalizeOrderStatus(order: GateOrder, filledQty: number, requestedAmount: number): string {
        const isFullFill = filledQty >= requestedAmount * (1 - 1e-8);
        if (isFullFill && (order.status === 'finished' || order.finish_as === 'filled')) {
            return 'closed';
        }

        if (order.finish_as === 'cancelled' || order.finish_as === 'ioc') {
            return 'canceled';
        }

        return order.status?.toLowerCase() || 'unknown';
    }

    private isFinalOrder(order: GateOrder): boolean {
        return order.status !== undefined && order.status !== 'open';
    }

    private assertIsolatedLeverage(symbol: string, expected: number, position: GatePosition): void {
        const actual = Number(position.lever ?? position.leverage);
        if (!Number.isFinite(actual)) {
            throw new Error(`Gate leverage response for ${symbol} does not include confirmed leverage`);
        }

        if (Math.abs(actual - expected) > 1e-9) {
            throw new Error(`Gate leverage confirmation mismatch for ${symbol}: expected ${expected}, got ${actual}`);
        }

        if (position.pos_margin_mode && position.pos_margin_mode.toLowerCase() !== 'isolated') {
            throw new Error(`Gate margin mode confirmation mismatch for ${symbol}: ${position.pos_margin_mode}`);
        }
    }

    private getMultiplierOrThrow(gateSymbol: string, symbol: string): number {
        const market = this.markets.get(gateSymbol);
        const multiplier = Number(market?.quanto_multiplier);
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
            throw new Error(`Gate quanto_multiplier is missing for ${symbol}`);
        }
        return multiplier;
    }

    private baseAmountToContracts(gateSymbol: string, amount: number, multiplier: number): number {
        const market = this.markets.get(gateSymbol);
        const step = Number(market?.order_size_round || 1);
        const rawContracts = amount / multiplier;
        const roundedContracts = Math.floor((rawContracts / step) + 1e-8) * step;
        const normalized = Number(this.formatDecimal(roundedContracts, 16));

        if (!Number.isFinite(normalized) || normalized <= 0) {
            throw new Error(`Gate order size for ${gateSymbol} is below one valid contract step: amount=${amount}, multiplier=${multiplier}, step=${step}`);
        }

        return normalized;
    }

    private createOrderText(clientOrderId?: string): string {
        if (clientOrderId) {
            const raw = clientOrderId.startsWith('t-') ? clientOrderId.slice(2) : clientOrderId;
            const sanitized = raw.replace(/[^0-9A-Za-z_.-]/g, '');
            if (sanitized && Buffer.byteLength(sanitized, 'utf8') <= 16) {
                return `t-${sanitized}`;
            }

            return `t-${crypto.createHash('sha256').update(clientOrderId).digest('hex').slice(0, 16)}`;
        }

        const randomPart = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.slice(0, 16);
        return `t-${randomPart}`;
    }

    private isTradeableUsdtContract(contract: GateContract): boolean {
        const multiplier = Number(contract.quanto_multiplier);
        return contract.type === 'direct'
            && contract.name.endsWith('_USDT')
            && Number.isFinite(multiplier)
            && multiplier > 0;
    }

    private buildQueryString(query: Record<string, unknown>): string {
        return Object.keys(query)
            .filter(key => query[key] !== undefined && query[key] !== null)
            .sort()
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
            .join('&');
    }

    private normalizeRequestError(error: any): Error {
        if (error.response?.data) {
            const status = error.response.status ? ` ${error.response.status}` : '';
            return new Error(`Gate API Error${status}: ${JSON.stringify(error.response.data)}`);
        }

        if (error instanceof Error) {
            return error;
        }

        return new Error(String(error));
    }

    private formatError(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private formatDecimal(value: number, precision = 12): string {
        return Number(value).toFixed(precision).replace(/\.?0+$/, '');
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
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function isGateOrder(value: unknown): value is GateOrder {
    return typeof value === 'object'
        && value !== null
        && ('id' in value || 'text' in value || 'status' in value);
}

import { appConfig, mergeEnvKeys, normalizeRuntimePayload, type RuntimeCommandPayload } from '../config.js';
import { BinanceUsdmMetadata } from '../exchanges/binance-usdm/binance-usdm-metadata.js';
import { BybitLinearMetadata } from '../exchanges/bybit-linear/bybit-linear-metadata.js';
import { BinanceUsdmTradeWs } from '../exchanges/binance-usdm/binance-usdm-trade-ws.js';
import { BybitLinearTradeWs } from '../exchanges/bybit-linear/bybit-linear-trade-ws.js';
import type { OrderExecution, OrderIntent, TradeDirection, TradeWsClient } from '../exchanges/exchange-types.js';
import { createCloseIntents, createOpenIntents } from './order-intent.js';
import { commonDecimalStep, roundDownToStep } from '../utils/math.js';
import { sleep } from '../utils/http.js';

const DEFAULT_TEST_SYMBOL = 'XRP/USDT:USDT';
const DEFAULT_TEST_DIRECTION: TradeDirection = 'buy';

export interface TestTradeRequest {
    symbol?: string;
    amount_usdt?: number | string;
    direction?: TradeDirection;
    close_delay_ms?: number | string;
}

export interface TestTradeExchangePhaseMetrics {
    send_at: number | null;
    ack_at: number | null;
    fill_seen_at: number | null;
    submit_to_ack_ms: number | null;
    submit_to_fill_seen_ms: number | null;
    order_id: string | null;
    client_order_id: string | null;
    error: string | null;
}

export interface TestTradeExchangeMetrics {
    exchange: 'binance' | 'bybit';
    open: TestTradeExchangePhaseMetrics;
    close: TestTradeExchangePhaseMetrics;
    exchange_total_ms: number | null;
}

export interface TestTradeMetrics {
    detected_at: number;
    detected_iso: string;
    open_submit_started_at: number | null;
    open_finished_at: number | null;
    close_submit_started_at: number | null;
    close_finished_at: number | null;
    detection_to_open_finished_ms: number | null;
    open_finished_to_close_submit_ms: number | null;
    close_submit_to_close_finished_ms: number | null;
    total_ms: number | null;
    binance: TestTradeExchangeMetrics;
    bybit: TestTradeExchangeMetrics;
}

export interface TestTradeResult {
    success: boolean;
    runtime_config_id: number;
    symbol: string;
    exchange_symbol: string;
    direction: TradeDirection;
    amount_usdt: number;
    quantity: number;
    use_testnet: boolean;
    error: string | null;
    metrics: TestTradeMetrics;
}

interface TimedExecution {
    sendAt: number;
    execution: OrderExecution | null;
    error: string | null;
}

export async function runTestTrade(
    payload: RuntimeCommandPayload,
    request: TestTradeRequest = {},
): Promise<TestTradeResult> {
    const runtime = normalizeRuntimePayload(payload, { enforceTradeAmountCap: false });
    const keys = mergeEnvKeys(payload.keys);
    if (!keys.binance_api_key || !keys.binance_secret || !keys.bybit_api_key || !keys.bybit_secret) {
        throw new Error('Binance and Bybit API keys are required for test trade.');
    }

    const symbol = normalizeTestSymbol(request.symbol);
    const direction = request.direction ?? DEFAULT_TEST_DIRECTION;
    let amountUsdt = normalizeAmount(request.amount_usdt);
    const closeDelayMs = normalizeCloseDelay(request.close_delay_ms);
    const detectedAt = Date.now();
    const localTradeId = `test${detectedAt.toString(36)}`;

    const binanceMetadata = new BinanceUsdmMetadata({
        apiKey: keys.binance_api_key,
        apiSecret: keys.binance_secret,
        useTestnet: runtime.useTestnet,
    });
    const bybitMetadata = new BybitLinearMetadata({
        apiKey: keys.bybit_api_key,
        apiSecret: keys.bybit_secret,
        useTestnet: runtime.useTestnet,
    });

    const [binanceMarkets, bybitMarkets, binancePrice, bybitPrice] = await Promise.all([
        binanceMetadata.loadMarketInfo(),
        bybitMetadata.loadMarketInfo(),
        binanceMetadata.fetchLastPrice(symbol),
        bybitMetadata.fetchLastPrice(symbol),
    ]);
    const binanceMarket = binanceMarkets.get(symbol);
    const bybitMarket = bybitMarkets.get(symbol);
    if (!binanceMarket || !bybitMarket) {
        throw new Error(`${symbol} is not available on Binance USD-M and Bybit linear metadata.`);
    }

    const stepSize = commonDecimalStep(binanceMarket.stepSize, bybitMarket.stepSize);
    const referencePrice = Math.max(binancePrice, bybitPrice);
    const minQty = Math.max(binanceMarket.minQty, bybitMarket.minQty);
    const minNotional = Math.max(binanceMarket.minNotional, bybitMarket.minNotional);
    const orderSize = calculateDiagnosticOrderSize(amountUsdt, referencePrice, stepSize, minQty, minNotional);
    amountUsdt = orderSize.amountUsdt;
    const quantity = orderSize.quantity;
    if (amountUsdt > appConfig.testTradeMaxNotionalUsdt) {
        throw new Error(
            `TEST_TRADE_MAX_NOTIONAL_USDT=${appConfig.testTradeMaxNotionalUsdt} is below exchange minimum `
            + `for ${symbol}: requiredAmountUsdt=${roundForMessage(amountUsdt)}, minQty=${minQty}, minNotional=${minNotional}.`,
        );
    }
    if (quantity < minQty || quantity * referencePrice < minNotional) {
        throw new Error(`Test amount is below exchange limits: quantity=${quantity}, minQty=${minQty}, minNotional=${minNotional}.`);
    }

    await Promise.all([
        binanceMetadata.setLeverageAndMargin(symbol, runtime.leverage),
        bybitMetadata.setLeverageAndMargin(symbol, runtime.leverage),
    ]);

    const binanceClient = new BinanceUsdmTradeWs({
        apiKey: keys.binance_api_key,
        apiSecret: keys.binance_secret,
        useTestnet: runtime.useTestnet,
    });
    const bybitClient = new BybitLinearTradeWs({
        apiKey: keys.bybit_api_key,
        apiSecret: keys.bybit_secret,
        useTestnet: runtime.useTestnet,
    });
    const clients = new Map<'binance' | 'bybit', TradeWsClient>([
        ['binance', binanceClient],
        ['bybit', bybitClient],
    ]);

    let openSubmitStartedAt: number | null = null;
    let openFinishedAt: number | null = null;
    let closeSubmitStartedAt: number | null = null;
    let closeFinishedAt: number | null = null;
    let openResults = emptyResults();
    let closeResults = emptyResults();
    let error: string | null = null;

    try {
        await Promise.all([binanceClient.connect(), bybitClient.connect()]);
        const openIntents = createOpenIntents({
            localTradeId,
            primaryExchange: runtime.primaryExchange,
            secondaryExchange: runtime.secondaryExchange,
            symbol,
            direction,
            quantity,
        });
        openSubmitStartedAt = Date.now();
        openResults = await submitTwoLegs(clients, openIntents.primary, openIntents.secondary);
        openFinishedAt = maxExecutionTime(openResults.binance, openResults.bybit);
        const openError = firstResultError(openResults);
        if (openError) {
            error = openError;
            await cleanupOpenedLegs(clients, openIntents, openResults);
            return buildResult();
        }

        if (closeDelayMs > 0) {
            await sleep(closeDelayMs);
        }

        const closeIntents = createCloseIntents({
            localTradeId,
            primaryExchange: runtime.primaryExchange,
            secondaryExchange: runtime.secondaryExchange,
            symbol,
            direction,
            quantity,
        });
        closeSubmitStartedAt = Date.now();
        closeResults = await submitTwoLegs(clients, closeIntents.primary, closeIntents.secondary);
        closeFinishedAt = maxExecutionTime(closeResults.binance, closeResults.bybit);
        error = firstResultError(closeResults);
        return buildResult();
    } finally {
        await Promise.allSettled([binanceClient.close(), bybitClient.close()]);
    }

    function buildResult(): TestTradeResult {
        const success = error === null;
        const metrics = buildMetrics({
            detectedAt,
            openSubmitStartedAt,
            openFinishedAt,
            closeSubmitStartedAt,
            closeFinishedAt,
            openResults,
            closeResults,
        });
        return {
            success,
            runtime_config_id: runtime.runtimeConfigId,
            symbol,
            exchange_symbol: symbol.replace(':USDT', '').replace('/', ''),
            direction,
            amount_usdt: amountUsdt,
            quantity,
            use_testnet: runtime.useTestnet,
            error,
            metrics,
        };
    }
}

function normalizeTestSymbol(symbol: string | undefined): string {
    if (!symbol || symbol === 'XRPUSDT') {
        return DEFAULT_TEST_SYMBOL;
    }
    if (symbol === DEFAULT_TEST_SYMBOL) {
        return symbol;
    }
    throw new Error('Only XRPUSDT test trade is supported.');
}

function normalizeAmount(value: number | string | undefined): number {
    const amount = value === undefined || value === '' ? appConfig.testTradeAmountUsdt : Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('amount_usdt must be a positive number.');
    }
    return amount;
}

export function calculateDiagnosticOrderSize(
    requestedAmountUsdt: number,
    referencePrice: number,
    stepSize: number,
    minQty: number,
    minNotional: number,
): { amountUsdt: number; quantity: number } {
    if (referencePrice <= 0 || stepSize <= 0) {
        throw new Error('Cannot calculate diagnostic order size from invalid market metadata.');
    }

    const requiredQty = roundUpToStep(Math.max(minQty, minNotional / referencePrice), stepSize);
    const requestedQty = roundDownToStep(requestedAmountUsdt / referencePrice, stepSize);
    const quantity = Math.max(requestedQty, requiredQty);
    return {
        amountUsdt: quantity * referencePrice,
        quantity,
    };
}

function roundUpToStep(value: number, step: number): number {
    if (step <= 0) {
        return value;
    }
    return Math.ceil((value / step) - 1e-12) * step;
}

function roundForMessage(value: number): number {
    return Number(value.toFixed(8));
}

function normalizeCloseDelay(value: number | string | undefined): number {
    const delay = value === undefined || value === '' ? appConfig.testTradeCloseDelayMs : Number(value);
    if (!Number.isFinite(delay) || delay < 0) {
        throw new Error('close_delay_ms must be a non-negative number.');
    }
    return delay;
}

async function submitTwoLegs(
    clients: Map<'binance' | 'bybit', TradeWsClient>,
    primary: OrderIntent,
    secondary: OrderIntent,
): Promise<Record<'binance' | 'bybit', TimedExecution>> {
    const [primaryResult, secondaryResult] = await Promise.all([
        submitTimed(clients.get(primary.exchange)!, primary),
        submitTimed(clients.get(secondary.exchange)!, secondary),
    ]);
    return {
        [primary.exchange]: primaryResult,
        [secondary.exchange]: secondaryResult,
    } as Record<'binance' | 'bybit', TimedExecution>;
}

async function submitTimed(client: TradeWsClient, intent: OrderIntent): Promise<TimedExecution> {
    const sendAt = Date.now();
    try {
        return {
            sendAt,
            execution: await client.submitMarketOrder(intent),
            error: null,
        };
    } catch (error) {
        return {
            sendAt,
            execution: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function cleanupOpenedLegs(
    clients: Map<'binance' | 'bybit', TradeWsClient>,
    openIntents: ReturnType<typeof createOpenIntents>,
    openResults: Record<'binance' | 'bybit', TimedExecution>,
): Promise<void> {
    const closeIntents = createCloseIntents({
        localTradeId: `${openIntents.primary.clientOrderId}cleanup`,
        primaryExchange: openIntents.primary.exchange,
        secondaryExchange: openIntents.secondary.exchange,
        symbol: DEFAULT_TEST_SYMBOL,
        direction: openIntents.primary.side === 'buy' ? 'buy' : 'sell',
        quantity: openIntents.primary.quantity,
    });
    const cleanupTasks: Promise<TimedExecution>[] = [];
    if (openResults.binance.execution) {
        cleanupTasks.push(submitTimed(clients.get('binance')!, closeIntents.primary.exchange === 'binance' ? closeIntents.primary : closeIntents.secondary));
    }
    if (openResults.bybit.execution) {
        cleanupTasks.push(submitTimed(clients.get('bybit')!, closeIntents.primary.exchange === 'bybit' ? closeIntents.primary : closeIntents.secondary));
    }
    await Promise.allSettled(cleanupTasks);
}

function buildMetrics(params: {
    detectedAt: number;
    openSubmitStartedAt: number | null;
    openFinishedAt: number | null;
    closeSubmitStartedAt: number | null;
    closeFinishedAt: number | null;
    openResults: Record<'binance' | 'bybit', TimedExecution>;
    closeResults: Record<'binance' | 'bybit', TimedExecution>;
}): TestTradeMetrics {
    return {
        detected_at: params.detectedAt,
        detected_iso: new Date(params.detectedAt).toISOString(),
        open_submit_started_at: params.openSubmitStartedAt,
        open_finished_at: params.openFinishedAt,
        close_submit_started_at: params.closeSubmitStartedAt,
        close_finished_at: params.closeFinishedAt,
        detection_to_open_finished_ms: diff(params.detectedAt, params.openFinishedAt),
        open_finished_to_close_submit_ms: diff(params.openFinishedAt, params.closeSubmitStartedAt),
        close_submit_to_close_finished_ms: diff(params.closeSubmitStartedAt, params.closeFinishedAt),
        total_ms: diff(params.detectedAt, params.closeFinishedAt),
        binance: buildExchangeMetrics('binance', params.openResults.binance, params.closeResults.binance),
        bybit: buildExchangeMetrics('bybit', params.openResults.bybit, params.closeResults.bybit),
    };
}

function buildExchangeMetrics(exchange: 'binance' | 'bybit', open: TimedExecution, close: TimedExecution): TestTradeExchangeMetrics {
    const openPhase = buildPhaseMetrics(open);
    const closePhase = buildPhaseMetrics(close);
    return {
        exchange,
        open: openPhase,
        close: closePhase,
        exchange_total_ms: diff(openPhase.send_at, closePhase.ack_at),
    };
}

function buildPhaseMetrics(result: TimedExecution): TestTradeExchangePhaseMetrics {
    const execution = result.execution;
    return {
        send_at: result.sendAt || null,
        ack_at: execution?.acknowledgedAt ?? null,
        fill_seen_at: execution?.filledAt ?? null,
        submit_to_ack_ms: diff(result.sendAt, execution?.acknowledgedAt ?? null),
        submit_to_fill_seen_ms: diff(result.sendAt, execution?.filledAt ?? null),
        order_id: execution?.orderId ?? null,
        client_order_id: execution?.clientOrderId ?? null,
        error: result.error,
    };
}

function emptyResults(): Record<'binance' | 'bybit', TimedExecution> {
    return {
        binance: { sendAt: 0, execution: null, error: null },
        bybit: { sendAt: 0, execution: null, error: null },
    };
}

function maxExecutionTime(left: TimedExecution, right: TimedExecution): number | null {
    const times = [completionTime(left), completionTime(right)].filter((value): value is number => value !== null);
    return times.length > 0 ? Math.max(...times) : null;
}

function completionTime(result: TimedExecution): number | null {
    if (!result.execution) {
        return null;
    }
    return result.execution.filledAt ?? result.execution.acknowledgedAt;
}

function firstResultError(results: Record<'binance' | 'bybit', TimedExecution>): string | null {
    return results.binance.error ?? results.bybit.error;
}

function diff(start: number | null, end: number | null): number | null {
    if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
    }
    return end - start;
}

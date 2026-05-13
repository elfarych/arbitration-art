import type { IExchangeClient } from './exchange-client.js';
import { BinanceClient } from './binance-client.js';
import { BybitClient } from './bybit-client.js';
import { GateClient } from './gate-client.js';
import { MexcClient } from './mexc-client.js';
import { logger } from '../utils/logger.js';

const TAG = 'ExchangeTester';

/**
 * On-demand exchange key tests invoked from Django's user profile.
 *
 * These helpers are intentionally decoupled from BotTrader and the Engine
 * lifecycle: they spin up a short-lived native REST client, run the
 * requested probe, and return a structured result. They never touch the
 * engine's bot registry and never persist anything on the engine side.
 *
 * Routing test trades through the engine — instead of letting Django call
 * the exchange directly — guarantees that the same code path responsible
 * for real trading is exercised when the user verifies their keys.
 */

export type SupportedExchange = 'binance' | 'bybit' | 'gate' | 'mexc';

export interface CheckResult {
    name: string;
    ok: boolean;
    detail: string;
}

export interface ConnectionTestResult {
    ok: boolean;
    exchange: SupportedExchange;
    checks: CheckResult[];
    error: string;
}

export interface TradeTestResult {
    success: boolean;
    exchange: SupportedExchange;
    symbol: string;
    margin_usd: number;
    leverage: number;
    quantity: number;
    open_price: number;
    close_price: number;
    open_latency_ms: number;
    close_latency_ms: number;
    realized_pnl_usdt: number;
    open_order_id: string;
    close_order_id: string;
    error: string;
    steps: CheckResult[];
}

export const TEST_TRADE_SYMBOL = 'SOL/USDT:USDT';
export const TEST_TRADE_SYMBOL_DISPLAY = 'SOL/USDT';
export const TEST_TRADE_MARGIN_USD = 15;
export const TEST_TRADE_LEVERAGE = 10;

const SUPPORTED: readonly SupportedExchange[] = ['binance', 'bybit', 'gate', 'mexc'];

export function isSupportedExchange(value: unknown): value is SupportedExchange {
    return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value);
}

function buildClient(exchange: SupportedExchange, apiKey: string, secret: string): IExchangeClient {
    switch (exchange) {
        case 'binance': return new BinanceClient(apiKey, secret);
        case 'bybit':   return new BybitClient(apiKey, secret);
        case 'gate':    return new GateClient(apiKey, secret);
        case 'mexc':    return new MexcClient(apiKey, secret);
    }
}

async function safeCheck(name: string, fn: () => Promise<string>): Promise<CheckResult> {
    try {
        const detail = await fn();
        return { name, ok: true, detail };
    } catch (e: any) {
        return { name, ok: false, detail: e?.message || String(e) };
    }
}

/**
 * Read-only probe: load markets and fetch SOL/USDT positions.
 * `fetchPositions` is the smallest auth-requiring call that exercises
 * futures read permissions across all four exchanges through the unified
 * `IExchangeClient` surface.
 */
export async function testConnection(
    exchange: SupportedExchange,
    apiKey: string,
    secret: string,
): Promise<ConnectionTestResult> {
    const result: ConnectionTestResult = { ok: false, exchange, checks: [], error: '' };

    let client: IExchangeClient;
    try {
        client = buildClient(exchange, apiKey, secret);
    } catch (e: any) {
        result.error = `Client init failed: ${e?.message ?? e}`;
        return result;
    }

    const loadMarkets = await safeCheck('Load markets', async () => {
        await client.loadMarkets();
        return 'ok';
    });
    result.checks.push(loadMarkets);
    if (!loadMarkets.ok) {
        result.error = loadMarkets.detail;
        return result;
    }

    const positions = await safeCheck('Fetch positions', async () => {
        const data = await client.fetchPositions([TEST_TRADE_SYMBOL]);
        return `positions fetched: ${data.length}`;
    });
    result.checks.push(positions);
    if (!positions.ok) {
        result.error = positions.detail;
        return result;
    }

    result.ok = true;
    return result;
}

function coerce(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function roundQty(client: IExchangeClient, symbol: string, raw: number): number {
    const info = client.getMarketInfo(symbol);
    if (!info) return raw;
    const step = info.stepSize > 0 ? info.stepSize : 0;
    if (step <= 0) return raw;
    return Math.floor(raw / step) * step;
}

/**
 * Round-trip futures trade: opens a market long sized to
 * (margin_usd * leverage) notional and immediately closes it with
 * reduceOnly. Each leg's wall-clock latency is captured around the
 * createMarketOrder call so the caller can attribute time to the exchange's
 * matching engine rather than any Django/Fastify hop.
 */
export async function testTrade(
    exchange: SupportedExchange,
    apiKey: string,
    secret: string,
): Promise<TradeTestResult> {
    const result: TradeTestResult = {
        success: false,
        exchange,
        symbol: TEST_TRADE_SYMBOL_DISPLAY,
        margin_usd: TEST_TRADE_MARGIN_USD,
        leverage: TEST_TRADE_LEVERAGE,
        quantity: 0,
        open_price: 0,
        close_price: 0,
        open_latency_ms: 0,
        close_latency_ms: 0,
        realized_pnl_usdt: 0,
        open_order_id: '',
        close_order_id: '',
        error: '',
        steps: [],
    };

    let client: IExchangeClient;
    try {
        client = buildClient(exchange, apiKey, secret);
    } catch (e: any) {
        result.error = `Client init failed: ${e?.message ?? e}`;
        return result;
    }

    const symbol = TEST_TRADE_SYMBOL;

    try {
        await client.loadMarkets();
        result.steps.push({ name: 'Load markets', ok: true, detail: 'ok' });
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        result.steps.push({ name: 'Load markets', ok: false, detail: msg });
        result.error = msg;
        return result;
    }

    // Warm adapter-level account settings (e.g. Binance Hedge Mode) before
    // the first order so it can be constructed correctly on first try
    // instead of relying on a lazy in-order probe.
    if (typeof client.prefetchAccountSettings === 'function') {
        try {
            await client.prefetchAccountSettings(symbol);
            result.steps.push({ name: 'Prefetch account settings', ok: true, detail: 'ok' });
        } catch (e: any) {
            result.steps.push({ name: 'Prefetch account settings', ok: false, detail: e?.message ?? String(e) });
        }
    }

    try {
        await client.setIsolatedMargin(symbol);
        result.steps.push({ name: 'Set margin mode', ok: true, detail: 'isolated' });
    } catch (e: any) {
        result.steps.push({ name: 'Set margin mode', ok: false, detail: e?.message ?? String(e) });
    }

    try {
        await client.setLeverage(symbol, TEST_TRADE_LEVERAGE);
        result.steps.push({ name: 'Set leverage', ok: true, detail: `${TEST_TRADE_LEVERAGE}x` });
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        result.steps.push({ name: 'Set leverage', ok: false, detail: msg });
        result.error = `setLeverage failed: ${msg}`;
        return result;
    }

    let lastPrice = 0;
    try {
        const ticker = await client.fetchTicker(symbol);
        lastPrice = coerce(ticker.last);
        if (lastPrice <= 0) throw new Error('Empty ticker price');
        const notional = TEST_TRADE_MARGIN_USD * TEST_TRADE_LEVERAGE;
        const rawQty = notional / lastPrice;
        const qty = roundQty(client, symbol, rawQty);
        if (qty <= 0) throw new Error('Quantity rounds to zero; increase margin_usd');
        result.quantity = qty;
        result.steps.push({ name: 'Size order', ok: true, detail: `qty=${qty} price=${lastPrice}` });
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        result.steps.push({ name: 'Size order', ok: false, detail: msg });
        result.error = msg;
        return result;
    }

    let openOrder;
    try {
        const t0 = Date.now();
        openOrder = await client.createMarketOrder(symbol, 'buy', result.quantity);
        const t1 = Date.now();
        result.open_latency_ms = t1 - t0;
        result.open_order_id = String(openOrder.orderId || '');
        result.open_price = coerce(openOrder.avgPrice);
        result.steps.push({
            name: 'Open long',
            ok: true,
            detail: `id=${result.open_order_id} avg=${result.open_price} latency=${result.open_latency_ms}ms`,
        });
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        result.steps.push({ name: 'Open long', ok: false, detail: msg });
        result.error = `Open order failed: ${msg}`;
        return result;
    }

    try {
        const t0 = Date.now();
        const closeOrder = await client.createMarketOrder(symbol, 'sell', result.quantity, { reduceOnly: true });
        const t1 = Date.now();
        result.close_latency_ms = t1 - t0;
        result.close_order_id = String(closeOrder.orderId || '');
        result.close_price = coerce(closeOrder.avgPrice);
        result.steps.push({
            name: 'Close long',
            ok: true,
            detail: `id=${result.close_order_id} avg=${result.close_price} latency=${result.close_latency_ms}ms`,
        });
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        result.steps.push({ name: 'Close long', ok: false, detail: msg });
        result.error = `Close order failed: ${msg}. Position is likely still OPEN; close it manually.`;
        logger.error(TAG, `Close failed for ${exchange} test trade: ${msg}`);
        return result;
    }

    if (result.open_price > 0 && result.close_price > 0) {
        result.realized_pnl_usdt = (result.close_price - result.open_price) * result.quantity;
    }

    result.success = true;
    return result;
}

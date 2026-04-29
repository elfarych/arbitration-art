import { appConfig } from '../config.js';
import type { ActiveTrade, ClosedTrade } from '../execution/trade-state.js';
import { d } from '../utils/math.js';

export interface TradeOpenPayload {
    runtime_config: number;
    coin: string;
    primary_exchange: string;
    secondary_exchange: string;
    order_type: 'buy' | 'sell';
    status: 'open';
    amount: number;
    leverage: number;
    primary_open_price: number;
    secondary_open_price: number;
    primary_open_order_id: string;
    secondary_open_order_id: string;
    open_spread: number;
    open_commission: number;
}

export interface TradeClosePayload {
    status: 'closed' | 'force_closed';
    close_reason: 'profit' | 'timeout' | 'shutdown' | 'error';
    primary_close_price: number;
    secondary_close_price: number;
    primary_close_order_id: string;
    secondary_close_order_id: string;
    close_spread: number;
    close_commission: number;
    profit_usdt: number;
    profit_percentage: number;
    closed_at: string;
}

export interface DjangoTradeRecord {
    id: number;
}

export class TradeSyncService {
    async createOpenTrade(activeTrade: ActiveTrade, leverage: number): Promise<DjangoTradeRecord> {
        const payload = toOpenPayload(activeTrade, leverage);
        return this.request<DjangoTradeRecord>('/bots/real-trades/', 'POST', payload);
    }

    async closeTrade(djangoTradeId: number, closedTrade: ClosedTrade): Promise<DjangoTradeRecord> {
        const payload = toClosePayload(closedTrade);
        return this.request<DjangoTradeRecord>(`/bots/real-trades/${djangoTradeId}/`, 'PATCH', payload);
    }

    async fetchOpenTrades(runtimeConfigId: number): Promise<DjangoTradeRecord[]> {
        const url = `/bots/real-trades/?status=open&runtime_config_id=${encodeURIComponent(String(runtimeConfigId))}`;
        const response = await this.request<{ results?: DjangoTradeRecord[] } | DjangoTradeRecord[]>(url, 'GET');
        return Array.isArray(response) ? response : response.results ?? [];
    }

    private async request<T>(path: string, method: 'GET' | 'POST' | 'PATCH', payload?: unknown): Promise<T> {
        const response = await fetch(`${appConfig.djangoApiUrl}${path}`, {
            method,
            body: payload === undefined ? undefined : JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': appConfig.serviceToken,
            },
        });

        const body = await response.text();
        if (!response.ok) {
            throw new Error(`Django Trade sync failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
        }
        return body ? JSON.parse(body) as T : undefined as T;
    }
}

export function toOpenPayload(activeTrade: ActiveTrade, leverage: number): TradeOpenPayload {
    return {
        runtime_config: activeTrade.runtimeConfigId,
        coin: activeTrade.symbol,
        primary_exchange: `${activeTrade.primaryExchange}_futures`,
        secondary_exchange: `${activeTrade.secondaryExchange}_futures`,
        order_type: activeTrade.direction,
        status: 'open',
        amount: d(activeTrade.quantity),
        leverage,
        primary_open_price: d(activeTrade.primaryOpenPrice),
        secondary_open_price: d(activeTrade.secondaryOpenPrice),
        primary_open_order_id: activeTrade.primaryOpenOrderId,
        secondary_open_order_id: activeTrade.secondaryOpenOrderId,
        open_spread: d(activeTrade.openSpread, 4),
        open_commission: d(activeTrade.openCommission, 6),
    };
}

export function toClosePayload(closedTrade: ClosedTrade): TradeClosePayload {
    return {
        status: closedTrade.closeReason === 'profit' ? 'closed' : 'force_closed',
        close_reason: closedTrade.closeReason,
        primary_close_price: d(closedTrade.primaryClosePrice),
        secondary_close_price: d(closedTrade.secondaryClosePrice),
        primary_close_order_id: closedTrade.primaryCloseExecution.orderId,
        secondary_close_order_id: closedTrade.secondaryCloseExecution.orderId,
        close_spread: d(closedTrade.closeSpread, 4),
        close_commission: d(closedTrade.closeCommission, 6),
        profit_usdt: d(closedTrade.profitUsdt, 6),
        profit_percentage: d(closedTrade.profitPercentage, 4),
        closed_at: closedTrade.closedAt,
    };
}

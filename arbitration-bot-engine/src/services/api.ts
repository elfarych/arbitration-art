import { config } from '../config.js';
import type { TradeClosePayload, TradeOpenPayload, TradeRecord } from '../types/index.js';
import { requestJson } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const TAG = 'API';
const REQUEST_TIMEOUT_MS = 15_000;

const baseUrl = config.djangoApiUrl.replace(/\/$/, '');
const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Service-Token': config.serviceToken,
};

interface DjangoListResponse<T> {
    results?: T[];
}

async function djangoRequest<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number> } = {},
): Promise<T> {
    const query = options.query
        ? new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)])).toString()
        : '';
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    return requestJson<T>(url, {
        method,
        headers: authHeaders,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
}

/**
 * Thin adapter around Django trade endpoints.
 *
 * BotTrader does not know endpoint URLs or pagination formats; it calls this
 * module with normalised payloads and receives normalised TradeRecord objects.
 * Authentication is via `X-Service-Token` shared with Django; no JWT is used
 * on the service-to-service channel.
 */
export const api = {
    async openTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            const data = await djangoRequest<TradeRecord>('POST', '/bots/real-trades/', { body: payload });
            logger.info(TAG, `Trade opened in Django: ID=${data.id}, coin=${data.coin}`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `openTrade failed: ${e.message}`);
            throw e;
        }
    },

    async closeTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            const data = await djangoRequest<TradeRecord>('PATCH', `/bots/real-trades/${id}/`, { body: payload });
            logger.info(TAG, `Trade closed in Django: ID=${id}, profit=${payload.profit_usdt} USDT`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `closeTrade failed for ID=${id}: ${e.message}`);
            throw e;
        }
    },

    async updateTrade(id: number, payload: Record<string, any>): Promise<TradeRecord> {
        return djangoRequest<TradeRecord>('PATCH', `/bots/real-trades/${id}/`, { body: payload });
    },

    async getOpenTrades(botId: number): Promise<TradeRecord[]> {
        try {
            const data = await djangoRequest<DjangoListResponse<TradeRecord> | TradeRecord[]>(
                'GET',
                '/bots/real-trades/',
                { query: { status: 'open', bot_id: botId } },
            );
            if (Array.isArray(data)) return data;
            return data.results ?? [];
        } catch (e: any) {
            logger.error(TAG, `getOpenTrades failed: ${e.message}`);
            return [];
        }
    },

    async openEmulationTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            return await djangoRequest<TradeRecord>('POST', '/bots/trades/', { body: payload });
        } catch (e: any) {
            logger.error(TAG, `openEmulationTrade failed: ${e.message}`);
            throw e;
        }
    },

    async closeEmulationTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            return await djangoRequest<TradeRecord>('PATCH', `/bots/trades/${id}/`, { body: payload });
        } catch (e: any) {
            logger.error(TAG, `closeEmulationTrade failed: ${e.message}`);
            throw e;
        }
    },

    async updateEmulationTrade(id: number, payload: Record<string, any>): Promise<TradeRecord> {
        return djangoRequest<TradeRecord>('PATCH', `/bots/trades/${id}/`, { body: payload });
    },

    async getOpenEmulationTrades(botId: number): Promise<TradeRecord[]> {
        try {
            const data = await djangoRequest<DjangoListResponse<TradeRecord> | TradeRecord[]>(
                'GET',
                '/bots/trades/',
                { query: { status: 'open', bot_id: botId } },
            );
            if (Array.isArray(data)) return data;
            return data.results ?? [];
        } catch (e: any) {
            logger.error(TAG, `getOpenEmulationTrades failed: ${e.message}`);
            return [];
        }
    },
};

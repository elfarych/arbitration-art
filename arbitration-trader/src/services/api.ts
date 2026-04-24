import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import type {
    RuntimeConfigErrorPayload,
    TradeClosePayload,
    TradeOpenPayload,
    TradeRecord,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const TAG = 'API';

// Shared Django API client. These endpoints are used only for trade persistence
// and recovery; exchange execution happens in Trader through REST clients.
const client: AxiosInstance = axios.create({
    baseURL: config.djangoApiUrl,
    headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': config.serviceToken,
    },
    timeout: 15000,
});

/**
 * Thin adapter around the Django real-trades API.
 *
 * Keeping endpoint paths here prevents Trader from mixing trading decisions with
 * persistence details and DRF pagination handling.
 */
export const api = {
    async openTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            const { data } = await client.post('/bots/real-trades/', payload);
            logger.info(TAG, `Trade opened in Django: ID=${data.id}, coin=${data.coin}`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `openTrade failed: ${e?.response?.status} ${JSON.stringify(e?.response?.data) || e.message}`);
            throw e;
        }
    },

    async closeTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            const { data } = await client.patch(`/bots/real-trades/${id}/`, payload);
            logger.info(TAG, `Trade closed in Django: ID=${id}, profit=${payload.profit_usdt} USDT`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `closeTrade failed for ID=${id}: ${e?.response?.status} ${JSON.stringify(e?.response?.data) || e.message}`);
            throw e;
        }
    },

    async getOpenTrades(runtimeConfigId: number): Promise<TradeRecord[]> {
        try {
            const { data } = await client.get('/bots/real-trades/', {
                params: {
                    status: 'open',
                    runtime_config_id: runtimeConfigId,
                },
            });
            // Support both DRF paginated responses and a raw array response.
            const trades = data.results || data || [];
            logger.info(TAG, `Fetched ${trades.length} open trades from Django for runtime ${runtimeConfigId}`);
            return trades;
        } catch (e: any) {
            logger.error(TAG, `getOpenTrades failed: ${e?.response?.status} ${JSON.stringify(e?.response?.data) || e.message}`);
            throw new Error(`Failed to restore open trades for runtime ${runtimeConfigId}`);
        }
    },

    async createRuntimeConfigError(payload: RuntimeConfigErrorPayload): Promise<void> {
        try {
            await client.post('/bots/runtime-config-errors/', payload);
            logger.info(TAG, `Runtime error recorded in Django: runtime=${payload.runtime_config}, type=${payload.error_type}`);
        } catch (e: any) {
            logger.warn(TAG, `createRuntimeConfigError failed: ${e?.response?.status} ${JSON.stringify(e?.response?.data) || e.message}`);
        }
    },
};

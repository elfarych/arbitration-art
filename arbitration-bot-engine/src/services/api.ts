import axios, { AxiosInstance } from 'axios';
import { config } from '../config.js';
import type { TradeOpenPayload, TradeClosePayload, TradeRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';

const TAG = 'API';

const client: AxiosInstance = axios.create({
    baseURL: config.djangoApiUrl,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

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

    async getOpenTrades(): Promise<TradeRecord[]> {
        try {
            const { data } = await client.get('/bots/real-trades/', { params: { status: 'open' } });
            return data.results || data || [];
        } catch (e: any) {
             logger.error(TAG, `getOpenTrades failed: ${e.message}`);
             return [];
        }
    },

    async openEmulationTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            const { data } = await client.post('/bots/trades/', payload);
            return data;
        } catch (e: any) {
             logger.error(TAG, `openEmulationTrade failed: ${e.message}`);
             throw e;
        }
    },

    async closeEmulationTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            const { data } = await client.patch(`/bots/trades/${id}/`, payload);
            return data;
        } catch (e: any) {
             logger.error(TAG, `closeEmulationTrade failed: ${e.message}`);
             throw e;
        }
    },

    async getOpenEmulationTrades(): Promise<TradeRecord[]> {
        try {
            const { data } = await client.get('/bots/trades/', { params: { status: 'open' } });
            return data.results || data || [];
        } catch (e: any) {
             logger.error(TAG, `getOpenEmulationTrades failed: ${e.message}`);
             return [];
        }
    }
};

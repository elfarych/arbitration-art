import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const API_URL = process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api';

export interface EmulationTradePayload {
    coin: string;
    primary_exchange: string;
    secondary_exchange: string;
    order_type: 'buy' | 'sell';
    status: 'open' | 'closed';
    amount: number;
    primary_open_price: number;
    secondary_open_price: number;
    open_spread: number;
}

export interface EmulationTradeUpdate {
    status: 'closed';
    primary_close_price: number;
    secondary_close_price: number;
    close_spread: number;
    profit_percentage: number;
    closed_at: string;
}

const client: AxiosInstance = axios.create({
    baseURL: API_URL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
});

export const api = {
    async openTrade(payload: EmulationTradePayload) {
        try {
            const { data } = await client.post('/bots/trades/', payload);
            return data;
        } catch (e: any) {
            console.error('[API Error] openTrade:', e?.response?.status, e?.response?.data || e.message);
            throw e;
        }
    },
    async closeTrade(id: number, payload: EmulationTradeUpdate) {
        try {
            const { data } = await client.patch(`/bots/trades/${id}/`, payload);
            return data;
        } catch (e: any) {
            console.error('[API Error] closeTrade:', e?.response?.status, e?.response?.data || e.message);
            throw e;
        }
    },
    async getOpenTrades(): Promise<any[]> {
        try {
            const { data } = await client.get('/bots/trades/', {
                params: { status: 'open' },
            });
            return data.results || data || [];
        } catch (e: any) {
            console.error('[API Error] getOpenTrades:', e?.response?.status, e?.response?.data || e.message);
            return [];
        }
    }
};

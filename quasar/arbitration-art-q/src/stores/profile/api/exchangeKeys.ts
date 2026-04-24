import { api } from 'boot/axios';

export type ExchangeId = 'binance' | 'bybit' | 'gate' | 'mexc';

export interface ExchangeKeyState {
  has_api_key: boolean;
  has_secret: boolean;
  api_key_preview: string;
  secret_preview: string;
}

export type ExchangeKeysState = Record<ExchangeId, ExchangeKeyState>;

export type ExchangeKeysPayload = Partial<{
  binance_api_key: string;
  binance_secret: string;
  bybit_api_key: string;
  bybit_secret: string;
  gate_api_key: string;
  gate_secret: string;
  mexc_api_key: string;
  mexc_secret: string;
}>;

export const exchangeKeysApi = {
  async get(): Promise<ExchangeKeysState> {
    const { data } = await api.get<ExchangeKeysState>('/auth/exchange-keys/');
    return data;
  },

  async update(payload: ExchangeKeysPayload): Promise<ExchangeKeysState> {
    const { data } = await api.patch<ExchangeKeysState>('/auth/exchange-keys/', payload);
    return data;
  },
};

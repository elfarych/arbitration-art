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

export interface ExchangeCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ExchangeConnectionTestResult {
  ok: boolean;
  exchange: ExchangeId;
  checks: ExchangeCheckResult[];
  error: string;
}

export interface ExchangeTradeTestResult {
  success: boolean;
  exchange: ExchangeId;
  symbol: string;
  notional_usd: number;
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
  steps: ExchangeCheckResult[];
}

export const exchangeKeysApi = {
  async get(): Promise<ExchangeKeysState> {
    const { data } = await api.get<ExchangeKeysState>('/auth/exchange-keys/');
    return data;
  },

  async update(payload: ExchangeKeysPayload): Promise<ExchangeKeysState> {
    const { data } = await api.patch<ExchangeKeysState>('/auth/exchange-keys/', payload);
    return data;
  },

  async testConnection(exchange: ExchangeId): Promise<ExchangeConnectionTestResult> {
    const { data } = await api.post<ExchangeConnectionTestResult>(
      `/auth/exchange-keys/${exchange}/test-connection/`,
    );
    return data;
  },

  async testTrade(exchange: ExchangeId): Promise<ExchangeTradeTestResult> {
    const { data } = await api.post<ExchangeTradeTestResult>(
      `/auth/exchange-keys/${exchange}/test-trade/`,
    );
    return data;
  },
};

import { defineStore } from 'pinia';
import {
  exchangeKeysApi,
  type ExchangeConnectionTestResult,
  type ExchangeId,
  type ExchangeKeysPayload,
  type ExchangeKeysState,
  type ExchangeTradeTestResult,
} from './api/exchangeKeys';

const emptyExchangeState = {
  has_api_key: false,
  has_secret: false,
  api_key_preview: '',
  secret_preview: '',
};

export type ExchangeTestKind = 'connection' | 'trade';

export const useProfileStore = defineStore('profile', {
  state: () => ({
    exchangeKeys: {
      binance: { ...emptyExchangeState },
      bybit: { ...emptyExchangeState },
      gate: { ...emptyExchangeState },
      mexc: { ...emptyExchangeState },
    } as ExchangeKeysState,
    loading: false,
    saving: false,
    testing: {
      binance: null,
      bybit: null,
      gate: null,
      mexc: null,
    } as Record<ExchangeId, ExchangeTestKind | null>,
  }),
  actions: {
    async fetchExchangeKeys() {
      this.loading = true;
      try {
        this.exchangeKeys = await exchangeKeysApi.get();
      } finally {
        this.loading = false;
      }
    },

    async updateExchangeKeys(payload: ExchangeKeysPayload) {
      this.saving = true;
      try {
        this.exchangeKeys = await exchangeKeysApi.update(payload);
      } finally {
        this.saving = false;
      }
    },

    async clearExchangeKeys(exchange: ExchangeId) {
      const payload = {
        [`${exchange}_api_key`]: '',
        [`${exchange}_secret`]: '',
      } as ExchangeKeysPayload;

      await this.updateExchangeKeys(payload);
    },

    async testConnection(exchange: ExchangeId): Promise<ExchangeConnectionTestResult> {
      this.testing[exchange] = 'connection';
      try {
        return await exchangeKeysApi.testConnection(exchange);
      } finally {
        this.testing[exchange] = null;
      }
    },

    async testTrade(exchange: ExchangeId): Promise<ExchangeTradeTestResult> {
      this.testing[exchange] = 'trade';
      try {
        return await exchangeKeysApi.testTrade(exchange);
      } finally {
        this.testing[exchange] = null;
      }
    },
  },
});

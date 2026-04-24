import { defineStore } from 'pinia';
import {
  exchangeKeysApi,
  type ExchangeId,
  type ExchangeKeysPayload,
  type ExchangeKeysState,
} from './api/exchangeKeys';

const emptyExchangeState = {
  has_api_key: false,
  has_secret: false,
  api_key_preview: '',
  secret_preview: '',
};

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
  },
});

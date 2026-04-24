import { defineStore } from 'pinia';
import {
  runtimeTradesApi,
  traderRuntimeConfigApi,
  traderRuntimeErrorsApi,
  type ActiveCoinsResponse,
  type ExchangeHealthResponse,
  type OpenTradesPnlResponse,
  type RuntimeTrade,
  type ServerInfoResponse,
  type SystemLoadResponse,
  type TraderRuntimeConfig,
  type TraderRuntimeConfigError,
  type TraderRuntimeConfigPayload,
} from './api/traderRuntimeConfig';

export const useTraderRuntimeStore = defineStore('traderRuntime', {
  state: () => ({
    configs: [] as TraderRuntimeConfig[],
    loading: false,
    saving: false,
    diagnosticsLoading: false,
    exchangeHealth: null as ExchangeHealthResponse | null,
    activeCoins: null as ActiveCoinsResponse | null,
    openTradesPnl: null as OpenTradesPnlResponse | null,
    systemLoad: null as SystemLoadResponse | null,
    serverInfo: null as ServerInfoResponse | null,
    errors: [] as TraderRuntimeConfigError[],
    trades: [] as RuntimeTrade[],
  }),
  actions: {
    async fetchConfigs() {
      this.loading = true;
      try {
        this.configs = await traderRuntimeConfigApi.list();
      } finally {
        this.loading = false;
      }
    },

    async createConfig(payload: TraderRuntimeConfigPayload) {
      this.saving = true;
      try {
        const created = await traderRuntimeConfigApi.create(payload);
        this.configs.unshift(created);
        return created;
      } finally {
        this.saving = false;
      }
    },

    async updateConfig(id: number, payload: Partial<TraderRuntimeConfigPayload>) {
      this.saving = true;
      try {
        const updated = await traderRuntimeConfigApi.update(id, payload);
        this.replaceConfig(updated);
        return updated;
      } finally {
        this.saving = false;
      }
    },

    async startConfig(id: number) {
      return this.updateConfig(id, { is_active: true });
    },

    async stopConfig(id: number) {
      return this.updateConfig(id, { is_active: false });
    },

    async syncConfig(id: number) {
      return this.updateConfig(id, { is_active: true });
    },

    async archiveConfig(id: number) {
      await traderRuntimeConfigApi.archive(id);
      this.configs = this.configs.filter((config) => config.id !== id);
    },

    async fetchExchangeHealth(id: number) {
      this.exchangeHealth = await traderRuntimeConfigApi.exchangeHealth(id);
      return this.exchangeHealth;
    },

    async fetchActiveCoins(id: number) {
      this.activeCoins = await traderRuntimeConfigApi.activeCoins(id);
      return this.activeCoins;
    },

    async fetchOpenTradesPnl(id: number) {
      this.openTradesPnl = await traderRuntimeConfigApi.openTradesPnl(id);
      return this.openTradesPnl;
    },

    async fetchSystemLoad(id: number) {
      this.systemLoad = await traderRuntimeConfigApi.systemLoad(id);
      return this.systemLoad;
    },

    async fetchServerInfo(id: number) {
      this.serverInfo = null;
      this.serverInfo = await traderRuntimeConfigApi.serverInfo(id);
      return this.serverInfo;
    },

    async refreshDiagnostics(id: number) {
      this.diagnosticsLoading = true;
      try {
        const [exchangeHealth, activeCoins, openTradesPnl, systemLoad] = await Promise.all([
          traderRuntimeConfigApi.exchangeHealth(id),
          traderRuntimeConfigApi.activeCoins(id),
          traderRuntimeConfigApi.openTradesPnl(id),
          traderRuntimeConfigApi.systemLoad(id),
        ]);
        this.exchangeHealth = exchangeHealth;
        this.activeCoins = activeCoins;
        this.openTradesPnl = openTradesPnl;
        this.systemLoad = systemLoad;
      } finally {
        this.diagnosticsLoading = false;
      }
    },

    async fetchErrors(id: number) {
      this.errors = await traderRuntimeErrorsApi.list(id);
    },

    async fetchTrades(id: number) {
      this.trades = await runtimeTradesApi.list(id);
    },

    clearRuntimeData() {
      this.exchangeHealth = null;
      this.activeCoins = null;
      this.openTradesPnl = null;
      this.systemLoad = null;
      this.serverInfo = null;
      this.errors = [];
      this.trades = [];
    },

    replaceConfig(updated: TraderRuntimeConfig) {
      const index = this.configs.findIndex((config) => config.id === updated.id);
      if (index === -1) {
        this.configs.unshift(updated);
      } else {
        this.configs[index] = updated;
      }
    },
  },
});

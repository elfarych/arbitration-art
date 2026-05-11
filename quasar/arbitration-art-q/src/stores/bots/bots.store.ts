import { defineStore } from 'pinia';
import {
  botConfigApi,
  type BotConfig,
  type BotConfigPayload,
} from './api/botConfig';

export const useBotsStore = defineStore('bots', {
  state: () => ({
    bots: [] as BotConfig[],
    loading: false,
  }),
  actions: {
    async fetchBots() {
      this.loading = true;
      try {
        this.bots = await botConfigApi.list();
      } finally {
        this.loading = false;
      }
    },

    async refreshBot(id: number) {
      // Refresh one bot in-place after a lifecycle command so the UI shows the
      // latest engine sync_status / last_sync_error without a full reload.
      const fresh = await botConfigApi.get(id);
      const idx = this.bots.findIndex(b => b.id === id);
      if (idx !== -1) {
        this.bots[idx] = fresh;
      }
      return fresh;
    },

    async toggleBot(bot: BotConfig) {
      const previousState = bot.is_active;
      // Optimistic local update for snappy UI; revert on failure.
      bot.is_active = !previousState;
      try {
        const updated = await botConfigApi.update(bot.id, { is_active: !previousState });
        const idx = this.bots.findIndex(b => b.id === bot.id);
        if (idx !== -1) {
          this.bots[idx] = updated;
        }
        return updated;
      } catch (e) {
        bot.is_active = previousState;
        throw e;
      }
    },

    async deleteBot(id: number) {
      await botConfigApi.delete(id);
      this.bots = this.bots.filter(b => b.id !== id);
    },

    async createBot(payload: BotConfigPayload) {
      const newBot = await botConfigApi.create(payload);
      this.bots.unshift(newBot);
      return newBot;
    },

    async updateBot(id: number, payload: Partial<BotConfigPayload>) {
      const updatedBot = await botConfigApi.update(id, payload);
      const idx = this.bots.findIndex(b => b.id === id);
      if (idx !== -1) {
        this.bots[idx] = updatedBot;
      }
      return updatedBot;
    },

    async forceCloseBot(id: number) {
      await botConfigApi.forceClose(id);
      // After force-close the engine state (and last_command/sync_status) may
      // have changed — refresh the row so the UI reflects it.
      await this.refreshBot(id).catch(() => undefined);
    },
  },
});

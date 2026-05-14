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
    // `silent` is used by background polling: the IndexPage spinner branch
    // hides the cards grid when `loading` is true, which would unmount every
    // BotCard on each poll (killing WS streams, restarting trade polls and
    // re-running skeleton states). Initial load still flips the flag so the
    // user sees the spinner instead of an empty grid.
    async fetchBots(options: { silent?: boolean } = {}) {
      const showSpinner = !options.silent;
      if (showSpinner) this.loading = true;
      try {
        this.bots = await botConfigApi.list();
      } finally {
        if (showSpinner) this.loading = false;
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
      // Idempotent insert: BotConfigViewSet.perform_create does inline
      // lifecycle sync with engine which can hold the POST open for seconds.
      // If BOT_LIST_POLL fires during that window, fetchBots replaces the
      // array with a fresh Django list that already contains newBot. Without
      // this guard, the subsequent unshift would add a duplicate row visible
      // until the next poll.
      const idx = this.bots.findIndex(b => b.id === newBot.id);
      if (idx === -1) {
        this.bots.unshift(newBot);
      } else {
        this.bots[idx] = newBot;
      }
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

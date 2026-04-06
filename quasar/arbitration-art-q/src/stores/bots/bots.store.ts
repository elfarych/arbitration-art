import { defineStore } from 'pinia';
import { botConfigApi, type BotConfig } from './api/botConfig';

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
      } catch (e) {
        console.error('Failed to load bots', e);
        throw e;
      } finally {
        this.loading = false;
      }
    },
    async toggleBot(bot: BotConfig) {
      const previousState = bot.is_active;
      bot.is_active = !previousState;
      try {
        await botConfigApi.update(bot.id, { is_active: !previousState });
        return true;
      } catch (e) {
        bot.is_active = previousState;
        throw e;
      }
    },
    async deleteBot(id: number) {
      try {
        await botConfigApi.delete(id);
        this.bots = this.bots.filter((b) => b.id !== id);
      } catch (e) {
        throw e;
      }
    },
    async createBot(payload: any) {
      try {
        const newBot = await botConfigApi.create(payload);
        this.bots.unshift(newBot);
        return newBot;
      } catch (e) {
        throw e;
      }
    },
    async updateBot(id: number, payload: any) {
      try {
        const updatedBot = await botConfigApi.update(id, payload);
        const index = this.bots.findIndex((b) => b.id === id);
        if (index !== -1) {
          this.bots[index] = updatedBot;
        }
        return updatedBot;
      } catch (e) {
        throw e;
      }
    }
  }
});

import { defineStore } from 'pinia';
import { pnlApi, type PnlByBotEntry, type PnlQuery, type PnlSummary } from './api/pnl';
import { rangeForPeriod } from './periods';

interface PnlState {
  // Today PnL is consumed by the header; keep it as its own slice so a
  // long-running summary fetch (PnL page) does not stall the header refresh.
  today: PnlSummary | null;
  todayLoading: boolean;
  todayError: string | null;

  // Lifetime per-bot PnL feeds BotCard. Indexed by bot_id for O(1) lookup.
  // Fetched once on first card mount, then refreshed by the periodic poll.
  lifetimeByBot: Record<number, PnlByBotEntry>;
  lifetimeLoading: boolean;
  lifetimeError: string | null;

  // Last summary fetched on the PnL page.
  current: PnlSummary | null;
  currentLoading: boolean;
  currentError: string | null;
}

function extractMessage(e: unknown, fallback: string): string {
  if (typeof e === 'object' && e !== null) {
    const maybeAxios = e as { response?: { data?: { detail?: string } } };
    if (maybeAxios.response?.data?.detail) return maybeAxios.response.data.detail;
    const maybeError = e as { message?: string };
    if (typeof maybeError.message === 'string') return maybeError.message;
  }
  return fallback;
}

export const usePnlStore = defineStore('pnl', {
  state: (): PnlState => ({
    today: null,
    todayLoading: false,
    todayError: null,
    lifetimeByBot: {},
    lifetimeLoading: false,
    lifetimeError: null,
    current: null,
    currentLoading: false,
    currentError: null,
  }),
  getters: {
    todayProfitUsdt: (state): number => parseFloat(state.today?.total?.profit_usdt ?? '0') || 0,
    todayTradesCount: (state): number => state.today?.total?.trades_count ?? 0,
    pnlForBot: (state) => (botId: number): PnlByBotEntry | null =>
      state.lifetimeByBot[botId] ?? null,
  },
  actions: {
    async fetchToday(options: { silent?: boolean } = {}) {
      const range = rangeForPeriod('today');
      if (!options.silent) this.todayLoading = true;
      try {
        this.today = await pnlApi.summary({ from: range.from, to: range.to });
        this.todayError = null;
      } catch (e) {
        this.todayError = extractMessage(e, 'Не удалось загрузить PnL за сегодня');
        // Keep the prior snapshot visible if this was a silent refresh.
        if (!options.silent) this.today = null;
        throw e;
      } finally {
        if (!options.silent) this.todayLoading = false;
      }
    },

    async fetchLifetimeByBot(options: { silent?: boolean } = {}) {
      if (!options.silent) this.lifetimeLoading = true;
      try {
        // `from`/`to` omitted = no upper/lower bound = lifetime.
        const summary = await pnlApi.summary({});
        const map: Record<number, PnlByBotEntry> = {};
        for (const row of summary.by_bot) map[row.bot_id] = row;
        this.lifetimeByBot = map;
        this.lifetimeError = null;
      } catch (e) {
        this.lifetimeError = extractMessage(e, 'Не удалось загрузить PnL ботов');
        throw e;
      } finally {
        if (!options.silent) this.lifetimeLoading = false;
      }
    },

    async fetchSummary(query: PnlQuery) {
      this.currentLoading = true;
      try {
        this.current = await pnlApi.summary(query);
        this.currentError = null;
      } catch (e) {
        this.currentError = extractMessage(e, 'Не удалось загрузить PnL');
        this.current = null;
        throw e;
      } finally {
        this.currentLoading = false;
      }
    },
  },
});

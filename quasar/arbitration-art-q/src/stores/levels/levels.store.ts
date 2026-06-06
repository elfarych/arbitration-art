import { defineStore } from 'pinia';
import { levelsApi, type ScreenerEntry } from './api/levelsApi';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Levels screener: a page of coins sorted by proximity to their nearest level,
// rendered as candlestick charts with the levels overlaid. Source of the rows
// is the art-level-screener `levels-api`.
//
// Page size is dynamic: the grid picker on the page sets it to columns × rows.
export const LEVELS_DEFAULT_PAGE_SIZE = 6;

// Default calculation params — match the levels-api env defaults so the initial
// screen matches the server's out-of-the-box calculation.
export const LEVELS_DEFAULT_MIN_VOLUME = 0; // 0 = volume filter off
export const LEVELS_DEFAULT_NATR_MULTIPLIER = 0.3;
export const LEVELS_DEFAULT_MIN_GAP = 12;

interface LevelsState {
  timeframes: string[];
  timeframe: string;
  entries: ScreenerEntry[];
  // Coins after filters, before pagination — drives pageCount.
  total: number;
  // 1-based page index.
  page: number;
  // Rows requested per page (= grid columns × rows).
  pageSize: number;
  // Calculation params sent to /screener (server recomputes on demand).
  // minVolume: minimum USDT turnover (sum of volume·close over 24×1h); 0 = off.
  minVolume: number;
  // natrMultiplier: touch-zone tolerance in NATR units.
  natrMultiplier: number;
  // minGap: minimum candles between counted touches.
  minGap: number;
  loading: boolean;
  error: string | null;
  // Wall-clock of the last successful fetch (ms) — for the "updated Xs ago" hint.
  fetchedAt: number | null;
}

export const useLevelsStore = defineStore('levels', {
  state: (): LevelsState => ({
    timeframes: [],
    timeframe: '',
    entries: [],
    total: 0,
    page: 1,
    pageSize: LEVELS_DEFAULT_PAGE_SIZE,
    minVolume: LEVELS_DEFAULT_MIN_VOLUME,
    natrMultiplier: LEVELS_DEFAULT_NATR_MULTIPLIER,
    minGap: LEVELS_DEFAULT_MIN_GAP,
    loading: false,
    error: null,
    fetchedAt: null,
  }),

  getters: {
    pageCount: (state): number => Math.max(1, Math.ceil(state.total / state.pageSize)),
  },

  actions: {
    async fetchTimeframes() {
      try {
        const tfs = await levelsApi.timeframes();
        this.timeframes = tfs;
        // Keep the current selection if still valid, otherwise pick the first.
        if (!this.timeframe || !tfs.includes(this.timeframe)) {
          this.timeframe = tfs[0] ?? '';
        }
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить таймфреймы');
        throw e;
      }
    },

    async fetchScreener() {
      if (!this.timeframe) return;
      this.loading = true;
      try {
        const result = await levelsApi.screener(this.timeframe, {
          sort: 'distance',
          order: 'asc',
          limit: this.pageSize,
          offset: (this.page - 1) * this.pageSize,
          // Volume filter is opt-in: send only when set (> 0).
          ...(this.minVolume > 0 ? { minVolume: this.minVolume } : {}),
          natrMultiplier: this.natrMultiplier,
          minGap: this.minGap,
        });
        this.entries = result.items;
        this.total = result.total;
        this.fetchedAt = Date.now();
        this.error = null;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить уровни');
        this.entries = [];
        this.total = 0;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    async setTimeframe(timeframe: string) {
      if (timeframe === this.timeframe) return;
      this.timeframe = timeframe;
      this.page = 1;
      await this.fetchScreener();
    },

    async setPage(page: number) {
      if (page === this.page) return;
      this.page = page;
      await this.fetchScreener();
    },

    // Grid layout change (columns × rows). Resets to the first page so the new
    // page size starts cleanly, then refetches.
    async setPageSize(pageSize: number) {
      if (pageSize < 1 || pageSize === this.pageSize) return;
      this.pageSize = pageSize;
      this.page = 1;
      await this.fetchScreener();
    },

    // Set calculation params (volume / NATR tolerance / touch gap). Applies only
    // the provided fields, resets to the first page (the result set changes), and
    // refetches. No-op when nothing actually changes — avoids a redundant recompute.
    async setParams(params: { minVolume?: number; natrMultiplier?: number; minGap?: number }) {
      let changed = false;
      if (params.minVolume !== undefined && params.minVolume !== this.minVolume) {
        this.minVolume = params.minVolume;
        changed = true;
      }
      if (params.natrMultiplier !== undefined && params.natrMultiplier !== this.natrMultiplier) {
        this.natrMultiplier = params.natrMultiplier;
        changed = true;
      }
      if (params.minGap !== undefined && params.minGap !== this.minGap) {
        this.minGap = params.minGap;
        changed = true;
      }
      if (!changed) return;
      this.page = 1;
      await this.fetchScreener();
    },
  },
});

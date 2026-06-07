import { defineStore } from 'pinia';
import { levelsApi, type ScreenerEntry } from './api/levelsApi';
import { useFavoritesStore } from './favorites.store';
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

// In "pin favorites" mode the screener has no by-symbol filter, so the whole
// universe is fetched in one request and paginated client-side. 500 is the API's
// max `limit`; if the filtered universe ever exceeds it, coins past 500 are not
// shown (pageCount reflects the fetched count).
const PINNED_FETCH_LIMIT = 500;

interface LevelsState {
  timeframes: string[];
  timeframe: string;
  // Items from the last fetch. Paged mode: the current page as sliced by the
  // server. Pinned mode: the full sorted-by-distance universe (favorites are
  // floated to the top and paginated client-side — see the `entries` getter).
  rawItems: ScreenerEntry[];
  // Coin count the server reported after filters (paged mode). In pinned mode the
  // count is rawItems.length — see the `total` getter.
  serverTotal: number;
  // 1-based page index.
  page: number;
  // Rows requested per page (= grid columns × rows).
  pageSize: number;
  // When true, favorite coins are pinned to the top of the whole screener,
  // keeping the proximity sort among them; the rest follow (also by proximity).
  pinFavorites: boolean;
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
    rawItems: [],
    serverTotal: 0,
    page: 1,
    pageSize: LEVELS_DEFAULT_PAGE_SIZE,
    pinFavorites: false,
    minVolume: LEVELS_DEFAULT_MIN_VOLUME,
    natrMultiplier: LEVELS_DEFAULT_NATR_MULTIPLIER,
    minGap: LEVELS_DEFAULT_MIN_GAP,
    loading: false,
    error: null,
    fetchedAt: null,
  }),

  getters: {
    // Coins after filters, before pagination — drives pageCount. Pinned mode
    // paginates the fetched universe client-side, so its total is what we fetched.
    total: (state): number =>
      state.pinFavorites ? state.rawItems.length : state.serverTotal,

    pageCount(): number {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },

    // The coins to render for the current page. Paged mode returns the server
    // page as-is. Pinned mode floats favorites to the top of the full universe
    // (preserving the proximity sub-order) and slices the current page — so it
    // reorders live when a star is toggled and pages without refetching.
    entries: (state): ScreenerEntry[] => {
      if (!state.pinFavorites) return state.rawItems;
      const favorites = useFavoritesStore().symbols;
      const pinned: ScreenerEntry[] = [];
      const rest: ScreenerEntry[] = [];
      for (const item of state.rawItems) {
        (favorites.has(item.symbol) ? pinned : rest).push(item);
      }
      const ordered = pinned.concat(rest);
      const start = (state.page - 1) * state.pageSize;
      return ordered.slice(start, start + state.pageSize);
    },
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
        const calc = {
          // Volume filter is opt-in: send only when set (> 0).
          ...(this.minVolume > 0 ? { minVolume: this.minVolume } : {}),
          natrMultiplier: this.natrMultiplier,
          minGap: this.minGap,
        };
        const result = await levelsApi.screener(this.timeframe, {
          sort: 'distance',
          order: 'asc',
          // Pinned mode needs the whole universe in one request (no by-symbol
          // filter) to float favorites to the top across pages; paged mode keeps
          // server-side limit/offset.
          ...(this.pinFavorites
            ? { limit: PINNED_FETCH_LIMIT, offset: 0 }
            : { limit: this.pageSize, offset: (this.page - 1) * this.pageSize }),
          ...calc,
        });
        this.rawItems = result.items;
        this.serverTotal = result.total;
        this.fetchedAt = Date.now();
        this.error = null;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить уровни');
        this.rawItems = [];
        this.serverTotal = 0;
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
      // Pinned mode paginates the already-fetched universe client-side (entries
      // getter), so no refetch; paged mode fetches the requested page.
      if (!this.pinFavorites) await this.fetchScreener();
    },

    // Grid layout change (columns × rows). Resets to the first page so the new
    // page size starts cleanly, then refetches.
    async setPageSize(pageSize: number) {
      if (pageSize < 1 || pageSize === this.pageSize) return;
      this.pageSize = pageSize;
      this.page = 1;
      await this.fetchScreener();
    },

    // Toggle pinning favorites to the top. The fetch shape (full universe vs one
    // page) and the paging model differ, so reset to the first page and refetch.
    async setPinFavorites(pin: boolean) {
      if (pin === this.pinFavorites) return;
      this.pinFavorites = pin;
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

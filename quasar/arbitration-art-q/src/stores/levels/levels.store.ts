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

// Volume filter floor: the screener and the notification config enforce a minimum
// 20M USDT turnover (sum of volume·close over 24×1h). This is both the default and
// the smallest selectable value — the filter cannot be lowered below it or turned
// off. Single source of truth for the floor across the page, filter and dialog.
export const LEVELS_MIN_VOLUME = 20_000_000;

// Default calculation params — NATR/gap match the levels-api env defaults so the
// initial screen matches the server's calculation; volume defaults to the floor.
export const LEVELS_DEFAULT_MIN_VOLUME = LEVELS_MIN_VOLUME;
export const LEVELS_DEFAULT_NATR_MULTIPLIER = 0.3;
export const LEVELS_DEFAULT_MIN_GAP = 12;

// Touch-zone tolerance can be specified two ways: 'natr' (band = natr × multiplier,
// adaptive to volatility) or 'pct' (band = ±tolerancePct% of price, fixed). The
// screener computes the band server-side, so percent mode is sent as a separate
// `tolerancePct` query param (a single multiplier can't express a uniform percent
// across coins with different NATR). Default keeps the historical NATR behaviour.
export type ToleranceMode = 'natr' | 'pct';
export const LEVELS_DEFAULT_TOLERANCE_MODE: ToleranceMode = 'natr';
export const LEVELS_DEFAULT_TOLERANCE_PCT = 0.5;

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
  // minVolume: minimum USDT turnover (sum of volume·close over 24×1h); floored at
  // LEVELS_MIN_VOLUME (20M) — always sent, never off.
  minVolume: number;
  // toleranceMode: which of the two tolerance inputs below is sent to the server.
  toleranceMode: ToleranceMode;
  // natrMultiplier: touch-zone tolerance in NATR units (used when mode = 'natr').
  natrMultiplier: number;
  // tolerancePct: touch-zone half-width as % of price (used when mode = 'pct').
  tolerancePct: number;
  // minGap: minimum candles between counted touches.
  minGap: number;
  // Case-insensitive symbol substring filter, matched server-side. Empty → off.
  search: string;
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
    toleranceMode: LEVELS_DEFAULT_TOLERANCE_MODE,
    natrMultiplier: LEVELS_DEFAULT_NATR_MULTIPLIER,
    tolerancePct: LEVELS_DEFAULT_TOLERANCE_PCT,
    minGap: LEVELS_DEFAULT_MIN_GAP,
    search: '',
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

    // Run the screener request for the current timeframe/page/filters and store
    // the result. Internal — fetchScreener wraps it with loading/error handling
    // and page clamping.
    async _fetchPage() {
      const calc = {
        // Volume filter is opt-in: send only when set (> 0).
        ...(this.minVolume > 0 ? { minVolume: this.minVolume } : {}),
        // Send exactly one tolerance input: tolerancePct (percent mode) overrides
        // natrMultiplier server-side, so the other is omitted to avoid ambiguity.
        ...(this.toleranceMode === 'pct'
          ? { tolerancePct: this.tolerancePct }
          : { natrMultiplier: this.natrMultiplier }),
        minGap: this.minGap,
      };
      const result = await levelsApi.screener(this.timeframe, {
        sort: 'distance',
        order: 'asc',
        // By-symbol search (case-insensitive substring); omitted when empty.
        ...(this.search ? { search: this.search } : {}),
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
    },

    async fetchScreener() {
      if (!this.timeframe) return;
      this.loading = true;
      try {
        await this._fetchPage();
        // A filter/search change can shrink the result set so the current page no
        // longer exists. Keep the page where possible, but clamp to the last valid
        // page so the screen never lands on an empty out-of-range page. Paged mode
        // then needs one corrective refetch for the new offset; pinned mode
        // paginates client-side (entries getter), so no refetch is needed.
        if (this.page > this.pageCount) {
          this.page = this.pageCount;
          if (!this.pinFavorites) await this._fetchPage();
        }
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

    // Set calculation params (volume / tolerance mode+value / touch gap). Applies
    // only the provided fields and refetches, keeping the current page
    // (fetchScreener clamps it down only if the new result set has fewer pages).
    // No-op when nothing actually changes — avoids a redundant recompute.
    async setParams(params: {
      minVolume?: number;
      toleranceMode?: ToleranceMode;
      natrMultiplier?: number;
      tolerancePct?: number;
      minGap?: number;
    }) {
      let changed = false;
      if (params.minVolume !== undefined && params.minVolume !== this.minVolume) {
        this.minVolume = params.minVolume;
        changed = true;
      }
      if (params.toleranceMode !== undefined && params.toleranceMode !== this.toleranceMode) {
        this.toleranceMode = params.toleranceMode;
        changed = true;
      }
      if (params.natrMultiplier !== undefined && params.natrMultiplier !== this.natrMultiplier) {
        this.natrMultiplier = params.natrMultiplier;
        changed = true;
      }
      if (params.tolerancePct !== undefined && params.tolerancePct !== this.tolerancePct) {
        this.tolerancePct = params.tolerancePct;
        changed = true;
      }
      if (params.minGap !== undefined && params.minGap !== this.minGap) {
        this.minGap = params.minGap;
        changed = true;
      }
      if (!changed) return;
      await this.fetchScreener();
    },

    // Set the by-symbol search filter (case-insensitive substring, matched
    // server-side). Trims input, no-ops when unchanged, resets to the first page
    // (the result set changes) and refetches in both paging modes (unlike
    // setPage, which skips the refetch in pinned mode).
    async setSearch(search: string) {
      const next = search.trim();
      if (next === this.search) return;
      this.search = next;
      this.page = 1;
      await this.fetchScreener();
    },
  },
});

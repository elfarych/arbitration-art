import { defineStore } from 'pinia';
import {
  analysisApi,
  type SavedAnalysis,
  type SavedAnalysisDetail,
} from './api/analysisApi';
import { levelsApi, type BreakoutDirection, type LevelsConfig } from './api/levelsApi';
import { runClientAnalysis } from './compute/analysisClient';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Breakout-analysis settings (the analysis dialog form). The analysis is computed
// in the browser (see ./compute — direct Binance fetch) and only the result is
// persisted in Django. This store holds the per-coin history (`items`), the
// selected analysis with its breakouts (`selected`), the cached calc params
// (`config` from levels-api) and the run/list/detail loading state.

export interface AnalysisSettings {
  timeframe: string;
  // Touch/breakout zone width in NATR units (= screener's natrMultiplier).
  natrMultiplier: number;
  minGap: number;
  direction: BreakoutDirection;
  maxBreakoutSeconds: number;
  minMovePct: number;
  candles: number;
}

export const ANALYSIS_DEFAULTS: Omit<AnalysisSettings, 'timeframe'> = {
  natrMultiplier: 0.3,
  minGap: 12,
  direction: 'both',
  maxBreakoutSeconds: 300,
  minMovePct: 0.5,
  candles: 1000,
};

interface AnalysisState {
  symbol: string;
  items: SavedAnalysis[];
  selected: SavedAnalysisDetail | null;
  // Calc params from levels-api /config, fetched once and cached (so the client
  // computes levels with the exact same params as the screener).
  config: LevelsConfig | null;
  listLoading: boolean;
  detailLoading: boolean;
  running: boolean;
  error: string | null;
}

function toSummary(detail: SavedAnalysisDetail): SavedAnalysis {
  const { breakouts: _breakouts, ...summary } = detail;
  return summary;
}

export const useAnalysisStore = defineStore('levelsAnalysis', {
  state: (): AnalysisState => ({
    symbol: '',
    items: [],
    selected: null,
    config: null,
    listLoading: false,
    detailLoading: false,
    running: false,
    error: null,
  }),

  actions: {
    // Load the saved-analysis history for a coin. Clears selection when the coin
    // changes so a stale detail from another coin doesn't linger.
    async fetchList(symbol: string) {
      if (symbol !== this.symbol) {
        this.selected = null;
      }
      this.symbol = symbol;
      this.listLoading = true;
      this.error = null;
      try {
        this.items = await analysisApi.list(symbol);
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить анализы');
        this.items = [];
      } finally {
        this.listLoading = false;
      }
    },

    // Compute a new analysis in the browser (direct Binance fetch), persist the
    // result in Django, prepend it to the list and select it.
    async run(symbol: string, settings: AnalysisSettings) {
      this.running = true;
      this.error = null;
      try {
        // Calc params (must match the screener) are fetched once and cached.
        if (!this.config) {
          this.config = await levelsApi.config();
        }
        const result = await runClientAnalysis(symbol, settings, this.config);
        const detail = await analysisApi.create(result);
        this.items.unshift(toSummary(detail));
        this.selected = detail;
      } catch (e) {
        // Binance/compute failures are plain Errors → surface their message;
        // Django save failures are axios → extractApiErrorMessage pulls the detail.
        this.error = extractApiErrorMessage(
          e,
          e instanceof Error ? e.message : 'Не удалось выполнить анализ',
        );
        throw e;
      } finally {
        this.running = false;
      }
    },

    // Load a saved analysis with its breakouts.
    async select(id: number) {
      if (this.selected?.id === id) return;
      this.detailLoading = true;
      this.error = null;
      try {
        this.selected = await analysisApi.get(id);
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить результаты');
        this.selected = null;
      } finally {
        this.detailLoading = false;
      }
    },

    reset() {
      this.symbol = '';
      this.items = [];
      this.selected = null;
      this.error = null;
    },
  },
});

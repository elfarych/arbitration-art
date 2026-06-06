import { defineStore } from 'pinia';
import {
  analysisApi,
  type SavedAnalysis,
  type SavedAnalysisDetail,
} from './api/analysisApi';
import type { BreakoutDirection } from './api/levelsApi';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Breakout-analysis settings (the analysis dialog form). The analysis runs and
// is persisted server-side in Django (which proxies levels-api); this store
// holds the per-coin history (`items`), the selected analysis with its breakouts
// (`selected`), and the run/list/detail loading state.

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

    // Run + persist a new analysis, prepend it to the list and select it.
    async run(symbol: string, settings: AnalysisSettings) {
      this.running = true;
      this.error = null;
      try {
        const detail = await analysisApi.create({
          symbol,
          timeframe: settings.timeframe,
          natrMultiplier: settings.natrMultiplier,
          minGap: settings.minGap,
          direction: settings.direction,
          maxBreakoutSeconds: settings.maxBreakoutSeconds,
          minMovePct: settings.minMovePct,
          candles: settings.candles,
        });
        this.items.unshift(toSummary(detail));
        this.selected = detail;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось выполнить анализ');
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

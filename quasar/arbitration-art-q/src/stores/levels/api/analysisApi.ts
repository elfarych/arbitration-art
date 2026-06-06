import { api } from 'boot/axios';
import type { AnalysisResult, AnalysisBreakout, BreakoutDirection } from './levelsApi';

// Saved breakout analyses live in Django (it proxies levels-api, persists, and
// serves history per user). Uses the authed `api` instance (JWT), unlike the
// screener which talks to levels-api directly. Django returns the same camelCase
// shape as levels-api's AnalysisResult, plus `id` and `createdAt`.

// List row: an analysis without its breakouts.
export type SavedAnalysis = Omit<AnalysisResult, 'breakouts'> & {
  id: number;
  createdAt: string;
};

// Full analysis with its breakouts (detail / create response).
export type SavedAnalysisDetail = SavedAnalysis & {
  breakouts: AnalysisBreakout[];
};

export interface AnalysisRunPayload {
  symbol: string;
  timeframe: string;
  // Omitted calc params fall back to levels-api env defaults server-side.
  natrMultiplier?: number;
  minGap?: number;
  direction: BreakoutDirection;
  maxBreakoutSeconds: number;
  minMovePct: number;
  candles?: number;
}

// DRF list may be a bare array or a paginated { results } envelope.
function unwrapList<T>(data: T[] | { results?: T[] }): T[] {
  return Array.isArray(data) ? data : (data.results ?? []);
}

export const analysisApi = {
  // Saved analyses for one coin, newest first (GET /levels/analyses/?symbol=).
  async list(symbol: string): Promise<SavedAnalysis[]> {
    const { data } = await api.get<SavedAnalysis[] | { results?: SavedAnalysis[] }>(
      '/levels/analyses/',
      { params: { symbol: symbol.toUpperCase() } },
    );
    return unwrapList(data);
  },

  // Run + persist a new analysis (POST /levels/analyses/). Django calls levels-api,
  // saves the result, and returns the full saved analysis with breakouts.
  async create(payload: AnalysisRunPayload): Promise<SavedAnalysisDetail> {
    const { data } = await api.post<SavedAnalysisDetail>('/levels/analyses/', payload);
    return data;
  },

  // Full saved analysis with breakouts (GET /levels/analyses/:id/).
  async get(id: number): Promise<SavedAnalysisDetail> {
    const { data } = await api.get<SavedAnalysisDetail>(`/levels/analyses/${id}/`);
    return data;
  },
};

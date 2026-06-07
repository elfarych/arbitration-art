import { api } from 'boot/axios';
import type { AnalysisResult, AnalysisBreakout } from './levelsApi';

// Saved breakout analyses live in Django, but the analysis itself is computed in
// the browser (see ../compute) — Django only persists the result and serves the
// per-user history. Uses the authed `api` instance (JWT), unlike the screener
// which talks to levels-api directly. Django returns the same camelCase shape as
// the computed AnalysisResult, plus `id` and `createdAt`.

// List row: an analysis without its breakouts.
export type SavedAnalysis = Omit<AnalysisResult, 'breakouts'> & {
  id: number;
  createdAt: string;
};

// Full analysis with its breakouts (detail / create response).
export type SavedAnalysisDetail = SavedAnalysis & {
  breakouts: AnalysisBreakout[];
};

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

  // Persist a browser-computed analysis (POST /levels/analyses/). Django validates
  // the structure, recomputes the summary server-side, saves it under the user,
  // and returns the full saved analysis with breakouts.
  async create(result: AnalysisResult): Promise<SavedAnalysisDetail> {
    const { data } = await api.post<SavedAnalysisDetail>('/levels/analyses/', result);
    return data;
  },

  // Full saved analysis with breakouts (GET /levels/analyses/:id/).
  async get(id: number): Promise<SavedAnalysisDetail> {
    const { data } = await api.get<SavedAnalysisDetail>(`/levels/analyses/${id}/`);
    return data;
  },
};

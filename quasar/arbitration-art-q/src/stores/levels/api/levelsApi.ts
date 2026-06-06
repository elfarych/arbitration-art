import axios from 'axios';

// Client for the art-level-screener `levels-api` service. It is a separate
// backend from Django (different host/port, no auth — CORS open), so it uses its
// own axios instance without the auth/refresh interceptors from boot/axios.
// Contract: art-level-screener/services/levels-api/API.md.
const DEFAULT_LEVELS_API_URL = 'http://127.0.0.1:3000';
const levelsHttp = axios.create({
  baseURL: process.env.LEVELS_API_URL ?? DEFAULT_LEVELS_API_URL,
});

export type LevelKind = 'top' | 'bottom';
export type LevelSide = 'support' | 'resistance';

// One horizontal level with its distance to the current price. Mirrors the
// LevelView model from API.md.
export interface LevelView {
  price: number;
  // Level start time — open of the extremum candle (ms, Unix).
  time: number;
  kind: LevelKind;
  side: LevelSide;
  touches: number;
  distancePct: number;
  // distancePct / natr; null when natr is 0.
  distanceNatr: number | null;
  // Breakout distance in %, only for broken levels; null otherwise.
  breakoutDistance: number | null;
}

// One coin row in the screener. `levels` holds all active (unbroken) levels,
// sorted by proximity (distanceNatr ascending).
export interface ScreenerEntry {
  symbol: string;
  price: number;
  natr: number;
  levels: LevelView[];
  nearest: LevelView | null;
  activeCount: number;
  brokenCount: number;
  updatedAt: number;
}

export interface ScreenerPage {
  timeframe: string;
  // Coins after filters, before pagination — drives page count.
  total: number;
  // Coins in this response.
  count: number;
  items: ScreenerEntry[];
}

export type ScreenerSort = 'distance' | 'natr' | 'symbol';
export type ScreenerOrder = 'asc' | 'desc';

export interface ScreenerQuery {
  // Calculation params (server recomputes on demand). Omitted → API env defaults.
  // Minimum USDT turnover (sum of volume·close over 24×1h); omit/0 → filter off.
  minVolume?: number;
  // Touch-zone tolerance in NATR units (band width = natr·natrMultiplier).
  natrMultiplier?: number;
  // Minimum gap in candles between touches (closer counts as one touch).
  minGap?: number;
  side?: LevelSide;
  maxDistanceNatr?: number;
  minActive?: number;
  search?: string;
  sort?: ScreenerSort;
  order?: ScreenerOrder;
  limit?: number;
  offset?: number;
}

function buildQuery(params: ScreenerQuery): string {
  const qs = new URLSearchParams();
  if (params.minVolume !== undefined) qs.set('minVolume', String(params.minVolume));
  if (params.natrMultiplier !== undefined) qs.set('natrMultiplier', String(params.natrMultiplier));
  if (params.minGap !== undefined) qs.set('minGap', String(params.minGap));
  if (params.side) qs.set('side', params.side);
  if (params.maxDistanceNatr !== undefined) qs.set('maxDistanceNatr', String(params.maxDistanceNatr));
  if (params.minActive !== undefined) qs.set('minActive', String(params.minActive));
  if (params.search) qs.set('search', params.search);
  if (params.sort) qs.set('sort', params.sort);
  if (params.order) qs.set('order', params.order);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const tail = qs.toString();
  return tail ? `?${tail}` : '';
}

export const levelsApi = {
  // Timeframes that currently have data (GET /timeframes).
  async timeframes(): Promise<string[]> {
    const { data } = await levelsHttp.get<string[]>('/timeframes');
    return data;
  },

  // Screener screen for a timeframe, already sorted by proximity to a level
  // (GET /screener/:tf). 404 (no data for the timeframe) surfaces as a thrown
  // axios error for the caller to handle.
  async screener(timeframe: string, params: ScreenerQuery = {}): Promise<ScreenerPage> {
    const { data } = await levelsHttp.get<ScreenerPage>(`/screener/${timeframe}${buildQuery(params)}`);
    return data;
  },
};

import axios from 'axios';

// Client for the art-level-screener `levels-api` service. It is a separate
// backend from Django (different host/port, no auth — CORS open), so it uses its
// own axios instance without the auth/refresh interceptors from boot/axios.
// Contract: art-level-screener/services/levels-api/API.md.
//
// process.env.LEVELS_API_URL is inlined at BUILD time, and only when present in
// a .env file the Quasar dotenv pipeline reads (build.env is not wired). In the
// Docker/Dokploy build there is no .env, so it resolves to undefined and the
// default below is what ships. Keep the default pointing at the production
// levels-api host (mirrors DEFAULT_API_URL in boot/axios.ts); local dev overrides
// it via the .env LEVELS_API_URL=http://127.0.0.1:3000.
const DEFAULT_LEVELS_API_URL = 'https://art-levels.jscode.kz';
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

// --- Breakout analysis (GET /analysis/:tf/:symbol) ---

export type BreakoutDirection = 'up' | 'down' | 'both';

// Request params for the breakout analysis. Omitted fields fall back to the
// levels-api env defaults (natrMultiplier/minGap/candles) or schema defaults.
export interface AnalysisParams {
  natrMultiplier?: number;
  minGap?: number;
  direction?: BreakoutDirection;
  maxBreakoutSeconds?: number;
  minMovePct?: number;
  candles?: number;
}

// One detected level breakout and its trade-based verdict. Mirrors the
// AnalysisBreakout model from API.md.
export interface AnalysisBreakout {
  price: number;
  // Level formation time — open of the extremum candle (ms, Unix).
  levelTime: number;
  kind: LevelKind;
  direction: 'up' | 'down';
  // Touches counted before the breakout.
  touches: number;
  // Open time of the first candle that broke the level (ms).
  breakoutCandleTime: number;
  // First trade leaving the level zone (ms); null when unconfirmed by trades.
  crossTime: number | null;
  // First trade reaching minMovePct beyond the level (ms); null otherwise.
  reachTime: number | null;
  // reachTime - crossTime (ms); null when either is missing.
  elapsedMs: number | null;
  // Max move beyond the level after the cross, %; null without a cross.
  movePct: number | null;
  matched: boolean;
  // ok | no_trades | no_cross | min_move_not_reached | too_slow
  reason: string;
}

export interface AnalysisResult {
  symbol: string;
  timeframe: string;
  // Effective params after defaults/caps applied by the server.
  params: {
    natrMultiplier: number;
    minGap: number;
    direction: BreakoutDirection;
    maxBreakoutSeconds: number;
    minMovePct: number;
    candles: number;
  };
  candlesAnalyzed: number;
  range: { from: number; to: number };
  summary: {
    breakoutsFound: number;
    // Breakouts verifiable against trades (excludes ones with no trades in the
    // window). matchRate is over this.
    evaluated: number;
    matched: number;
    unmatched: number;
    matchRate: number;
    byDirection: {
      up: { found: number; matched: number };
      down: { found: number; matched: number };
    };
  };
  breakouts: AnalysisBreakout[];
}

// Calculation params for the client-side analysis (GET /config). The frontend
// computes analyses itself and must use the SAME level params as the screener,
// so it reads the authoritative env defaults from levels-api instead of
// hardcoding them. `levels` is structurally a LevelParams (compute module).
export interface LevelsConfig {
  levels: {
    period: number;
    extremaWindow: number;
    maxBrokenAge: number;
    minTouches: number;
    minGap: number;
    natrMultiplier: number;
    atrPeriod: number;
  };
  analysis: {
    defaultCandles: number;
    maxCandles: number;
    aggTradesLimit: number;
    maxTradePages: number;
  };
  binance: {
    restUrl: string;
    weightLimitPerMin: number;
  };
}

export const levelsApi = {
  // Timeframes that currently have data (GET /timeframes).
  async timeframes(): Promise<string[]> {
    const { data } = await levelsHttp.get<string[]>('/timeframes');
    return data;
  },

  // Calculation params for the client-side analysis (GET /config).
  async config(): Promise<LevelsConfig> {
    const { data } = await levelsHttp.get<LevelsConfig>('/config');
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

import { api } from 'boot/axios';

// Match Django apps.bots.models RuntimeStatus / SyncStatus / LifecycleCommand
// TextChoices. Keep in sync if Django side changes.
export type EngineRuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'
  | 'archived';

export type EngineSyncStatus = 'idle' | 'pending' | 'success' | 'failed';

export type EngineLastCommand = 'start' | 'sync' | 'stop' | 'pause' | 'force-close' | '';

export interface BotConfig {
  id: number;
  service_url: string;
  primary_exchange: string;
  secondary_exchange: string;
  // Decimals come from DRF as strings; keep them as `string | number` so
  // financial precision is preserved through round-trips and component code
  // can decide when to convert.
  entry_spread: string | number;
  exit_spread: string | number;
  coin: string;
  coin_amount: string | number;
  order_type: 'buy' | 'sell' | 'auto';
  trade_mode: 'emulator' | 'real';
  max_trades: number;
  primary_leverage: number;
  secondary_leverage: number;
  trade_on_primary_exchange: boolean;
  trade_on_secondary_exchange: boolean;
  max_trade_duration_seconds: number;
  max_leg_drawdown_percent: number;
  is_active: boolean;
  // Engine integration status — populated by Django from the inline lifecycle
  // sync in BotConfigViewSet. UI uses these to surface engine availability and
  // last failure reason without polling the engine directly.
  status: EngineRuntimeStatus;
  sync_status: EngineSyncStatus;
  last_command: EngineLastCommand;
  last_sync_error: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// Fields the user can submit. service_url and engine-status fields are
// server-managed (see BotConfigSerializer.read_only_fields).
export type BotConfigPayload = Omit<
  BotConfig,
  | 'id'
  | 'service_url'
  | 'status'
  | 'sync_status'
  | 'last_command'
  | 'last_sync_error'
  | 'last_synced_at'
  | 'created_at'
  | 'updated_at'
>;

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// DRF returns paginated lists. Iterate `next` URLs to load every record; with
// StandardPagination max_page_size=500 the UI usually completes in one round
// trip but we still handle multi-page responses defensively.
async function fetchAllPages<T>(initialPath: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = initialPath;
  while (url) {
    const { data } = await api.get<Paginated<T>>(url);
    out.push(...data.results);
    // `next` is an absolute URL; convert it back to a path relative to the
    // axios baseURL so subsequent requests still go through the interceptor.
    if (data.next) {
      try {
        const u = new URL(data.next);
        url = `${u.pathname}${u.search}`;
        // Strip the /api prefix if axios baseURL already provides it.
        const baseUrl = api.defaults.baseURL || '';
        if (baseUrl) {
          try {
            const baseURLObj = new URL(baseUrl, window.location.origin);
            if (url.startsWith(baseURLObj.pathname)) {
              url = url.slice(baseURLObj.pathname.length) || '/';
            }
          } catch {
            // baseURL not a full URL (relative); use the path as-is.
          }
        }
      } catch {
        url = null;
      }
    } else {
      url = null;
    }
  }
  return out;
}

export interface EngineHealthResponse {
  ok?: boolean;
  bots?: number;
  [key: string]: unknown;
}

export const botConfigApi = {
  async list(): Promise<BotConfig[]> {
    // Request a large page so the typical case completes in one round-trip;
    // fetchAllPages still handles unexpectedly long lists.
    return fetchAllPages<BotConfig>('/bots/?page_size=500');
  },

  async get(id: number): Promise<BotConfig> {
    const { data } = await api.get<BotConfig>(`/bots/${id}/`);
    return data;
  },

  async create(payload: BotConfigPayload): Promise<BotConfig> {
    const { data } = await api.post<BotConfig>('/bots/', payload);
    return data;
  },

  async update(id: number, payload: Partial<BotConfigPayload>): Promise<BotConfig> {
    const { data } = await api.patch<BotConfig>(`/bots/${id}/`, payload);
    return data;
  },

  async delete(id: number): Promise<void> {
    await api.delete(`/bots/${id}/`);
  },

  async forceClose(id: number): Promise<void> {
    await api.post(`/bots/${id}/force-close/`);
  },

  async engineHealth(id: number): Promise<EngineHealthResponse> {
    const { data } = await api.get<EngineHealthResponse>(`/bots/${id}/engine-health/`);
    return data;
  },
};

export interface EmulationTrade {
  id: number;
  bot: number;
  coin: string;
  primary_exchange: string;
  secondary_exchange: string;
  order_type: 'buy' | 'sell';
  status: 'open' | 'closed';
  amount: string | number;
  primary_open_price: string | number;
  secondary_open_price: string | number;
  open_spread: string | number;
  primary_close_price: string | number | null;
  secondary_close_price: string | number | null;
  close_spread: string | number | null;
  profit_percentage: string | number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface RealTrade {
  id: number;
  owner: number | null;
  bot: number | null;
  runtime_config: number | null;
  coin: string;
  primary_exchange: string;
  secondary_exchange: string;
  order_type: 'buy' | 'sell';
  status: 'open' | 'closed' | 'force_closed';
  close_reason: 'profit' | 'timeout' | 'manual' | 'shutdown' | 'error' | null;
  amount: string | number;
  leverage: number;
  primary_open_price: string | number;
  secondary_open_price: string | number;
  primary_open_order_id: string | null;
  secondary_open_order_id: string | null;
  open_spread: string | number;
  open_commission: string | number;
  opened_at: string;
  primary_close_price: string | number | null;
  secondary_close_price: string | number | null;
  primary_close_order_id: string | null;
  secondary_close_order_id: string | null;
  close_spread: string | number | null;
  close_commission: string | number | null;
  profit_usdt: string | number | null;
  profit_percentage: string | number | null;
  closed_at: string | null;
}

interface TradesListParams {
  botId: number;
  status?: 'open' | 'closed';
  pageSize?: number;
}

function buildTradesQuery(params: TradesListParams): string {
  // Django filters TradeViewSet / EmulationTradeViewSet by bot_id (not `bot`),
  // see apps/bots/api/views.py get_queryset. Mismatched param names mean the
  // server returns the full user-scoped list; we must use bot_id.
  const qs = new URLSearchParams();
  qs.set('bot_id', String(params.botId));
  if (params.status) qs.set('status', params.status);
  qs.set('page_size', String(params.pageSize ?? 500));
  return qs.toString();
}

export const botTradesApi = {
  async list(params: TradesListParams): Promise<EmulationTrade[]> {
    return fetchAllPages<EmulationTrade>(`/bots/trades/?${buildTradesQuery(params)}`);
  },
};

export const realTradesApi = {
  async list(params: TradesListParams): Promise<RealTrade[]> {
    return fetchAllPages<RealTrade>(`/bots/real-trades/?${buildTradesQuery(params)}`);
  },
};

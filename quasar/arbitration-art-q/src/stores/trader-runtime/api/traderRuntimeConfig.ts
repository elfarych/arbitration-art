import { api } from 'boot/axios';

type PaginatedResponse<T> = {
  results: T[];
};

type ListResponse<T> = T[] | PaginatedResponse<T>;

export type TraderExchange = 'binance' | 'bybit' | 'gate' | 'mexc';
export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'archived';
export type SyncStatus = 'idle' | 'pending' | 'success' | 'failed';
export type RuntimeCommand = '' | 'start' | 'sync' | 'stop' | 'force-close';

export interface TraderRuntimeConfig {
  id: number;
  name: string;
  service_url: string;
  primary_exchange: TraderExchange;
  secondary_exchange: TraderExchange;
  trade_amount_usdt: string;
  leverage: number;
  max_concurrent_trades: number;
  top_liquid_pairs_count: number;
  max_trade_duration_minutes: number;
  max_leg_drawdown_percent: string;
  open_threshold: string;
  close_threshold: string;
  orderbook_limit: number;
  chunk_size: number;
  is_active: boolean;
  status: RuntimeStatus;
  sync_status: SyncStatus;
  last_command: RuntimeCommand;
  last_sync_error: string;
  last_synced_at: string | null;
  is_deleted: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TraderRuntimeConfigPayload = Pick<
  TraderRuntimeConfig,
  | 'name'
  | 'service_url'
  | 'primary_exchange'
  | 'secondary_exchange'
  | 'leverage'
  | 'max_concurrent_trades'
  | 'top_liquid_pairs_count'
  | 'max_trade_duration_minutes'
  | 'orderbook_limit'
  | 'chunk_size'
> & {
  trade_amount_usdt: number | string;
  max_leg_drawdown_percent: number | string;
  open_threshold: number | string;
  close_threshold: number | string;
  is_active?: boolean;
};

export interface ExchangeHealthResult {
  exchange: string;
  available: boolean;
  error: string | null;
}

export interface ExchangeHealthResponse {
  requested_runtime_config_id: number;
  active_runtime_config_id: number | null;
  exchanges: ExchangeHealthResult[];
}

export interface ActiveCoinsResponse {
  requested_runtime_config_id: number | null;
  active_runtime_config_id: number | null;
  is_requested_runtime_active: boolean;
  trade_count: number;
  active_coins: string[];
}

export interface RuntimeTradePnlSnapshot {
  trade_id: number;
  coin: string;
  order_type: 'buy' | 'sell';
  amount: number;
  opened_at: string;
  current_pnl_percent: number | null;
  estimated_pnl_usdt: number | null;
  estimated_pnl_percentage: number | null;
  pricing_mode: 'strict' | 'emergency' | 'unavailable';
}

export interface OpenTradesPnlResponse extends ActiveCoinsResponse {
  trades: RuntimeTradePnlSnapshot[];
}

export interface SystemLoadResponse {
  requested_runtime_config_id: number | null;
  active_runtime_config_id: number | null;
  runtime_state: 'idle' | 'running' | 'risk_locked' | 'stopping_with_open_exposure';
  risk_locked: boolean;
  cpu_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  memory_free_bytes: number;
  memory_used_percent: number;
}

export type RuntimeConfigErrorType =
  | 'start'
  | 'sync'
  | 'stop'
  | 'runtime'
  | 'exchange_health'
  | 'diagnostics'
  | 'validation'
  | 'control_plane';

export interface TraderRuntimeConfigError {
  id: number;
  runtime_config: number;
  error_type: RuntimeConfigErrorType;
  error_text: string;
  created_at: string;
}

export interface RuntimeTrade {
  id: number;
  runtime_config: number | null;
  coin: string;
  primary_exchange: string;
  secondary_exchange: string;
  order_type: 'buy' | 'sell' | 'auto';
  status: 'open' | 'closed' | 'force_closed';
  close_reason: string | null;
  amount: string;
  leverage: number;
  primary_open_price: string;
  secondary_open_price: string;
  primary_open_order_id: string | null;
  secondary_open_order_id: string | null;
  open_spread: string;
  open_commission: string;
  opened_at: string;
  primary_close_price: string | null;
  secondary_close_price: string | null;
  primary_close_order_id: string | null;
  secondary_close_order_id: string | null;
  close_spread: string | null;
  close_commission: string | null;
  profit_usdt: string | null;
  profit_percentage: string | null;
  closed_at: string | null;
}

function unwrapList<T>(data: ListResponse<T>): T[] {
  return Array.isArray(data) ? data : data.results;
}

export const traderRuntimeConfigApi = {
  async list(): Promise<TraderRuntimeConfig[]> {
    const { data } = await api.get<ListResponse<TraderRuntimeConfig>>('/bots/runtime-configs/');
    return unwrapList(data);
  },

  async get(id: number): Promise<TraderRuntimeConfig> {
    const { data } = await api.get<TraderRuntimeConfig>(`/bots/runtime-configs/${id}/`);
    return data;
  },

  async create(payload: TraderRuntimeConfigPayload): Promise<TraderRuntimeConfig> {
    const { data } = await api.post<TraderRuntimeConfig>('/bots/runtime-configs/', payload);
    return data;
  },

  async update(id: number, payload: Partial<TraderRuntimeConfigPayload>): Promise<TraderRuntimeConfig> {
    const { data } = await api.patch<TraderRuntimeConfig>(`/bots/runtime-configs/${id}/`, payload);
    return data;
  },

  async archive(id: number): Promise<void> {
    await api.delete(`/bots/runtime-configs/${id}/`);
  },

  async exchangeHealth(id: number): Promise<ExchangeHealthResponse> {
    const { data } = await api.get<ExchangeHealthResponse>(`/bots/runtime-configs/${id}/exchange-health/`);
    return data;
  },

  async activeCoins(id: number): Promise<ActiveCoinsResponse> {
    const { data } = await api.get<ActiveCoinsResponse>(`/bots/runtime-configs/${id}/active-coins/`);
    return data;
  },

  async openTradesPnl(id: number): Promise<OpenTradesPnlResponse> {
    const { data } = await api.get<OpenTradesPnlResponse>(`/bots/runtime-configs/${id}/open-trades-pnl/`);
    return data;
  },

  async systemLoad(id: number): Promise<SystemLoadResponse> {
    const { data } = await api.get<SystemLoadResponse>(`/bots/runtime-configs/${id}/system-load/`);
    return data;
  },
};

export const traderRuntimeErrorsApi = {
  async list(runtimeConfigId: number): Promise<TraderRuntimeConfigError[]> {
    const { data } = await api.get<ListResponse<TraderRuntimeConfigError>>('/bots/runtime-config-errors/', {
      params: { runtime_config_id: runtimeConfigId },
    });
    return unwrapList(data);
  },
};

export const runtimeTradesApi = {
  async list(runtimeConfigId: number): Promise<RuntimeTrade[]> {
    const { data } = await api.get<ListResponse<RuntimeTrade>>('/bots/real-trades/', {
      params: { runtime_config_id: runtimeConfigId },
    });
    return unwrapList(data);
  },
};

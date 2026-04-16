import { api } from 'boot/axios';

export interface BotConfig {
  id: number;
  primary_exchange: string;
  secondary_exchange: string;
  entry_spread: number;
  exit_spread: number;
  coin: string;
  coin_amount: number;
  order_type: 'buy' | 'sell' | 'auto';
  trade_mode: 'emulator' | 'real';
  max_trades: number;
  primary_leverage: number;
  secondary_leverage: number;
  trade_on_primary_exchange: boolean;
  trade_on_secondary_exchange: boolean;
  max_trade_duration_minutes: number;
  max_leg_drawdown_percent: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type BotConfigPayload = Omit<BotConfig, 'id' | 'created_at' | 'updated_at'>;

export const botConfigApi = {
  async list(): Promise<BotConfig[]> {
    const { data } = await api.get<{ results: BotConfig[] }>('/bots/');
    return data.results;
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
  }
};

export interface EmulationTrade {
  id: number;
  bot: number;
  status: 'open' | 'closed';
  amount: number;
  primary_open_price: number;
  secondary_open_price: number;
  open_spread: number;
  primary_close_price?: number;
  secondary_close_price?: number;
  close_spread?: number;
  profit_percentage?: number;
  opened_at: string;
  closed_at?: string;
}

export type CreateTradePayload = Pick<EmulationTrade, 'bot' | 'amount' | 'primary_open_price' | 'secondary_open_price' | 'open_spread'>;
export type CloseTradePayload = {
  status: 'closed';
  primary_close_price: number;
  secondary_close_price: number;
  close_spread: number;
  profit_percentage: number;
  closed_at: string;
};

export const botTradesApi = {
  async list(botId: number): Promise<EmulationTrade[]> {
    const { data } = await api.get<{ results: EmulationTrade[] }>(`/bots/trades/?bot=${botId}`);
    // Django filters may not be natively ?bot= by default unless django-filter is installed and plugged. Assuming basic list fetching and client filter or backend model filter for now.
    // Wait, the backend ViewSet doesn't filter by `bot` query param currently. It filters by `owner=request.user`. I should send the filtering query. Let's make sure it filters on backend if possible, or just fetch and filter. Actually `api.get('/bots/trades/')` gives all user trades, we can filter in the store or component.
    return data.results.filter(t => t.bot === botId);
  },

  async create(payload: CreateTradePayload): Promise<EmulationTrade> {
    const { data } = await api.post<EmulationTrade>('/bots/trades/', payload);
    return data;
  },

  async close(id: number, payload: CloseTradePayload): Promise<EmulationTrade> {
    const { data } = await api.patch<EmulationTrade>(`/bots/trades/${id}/`, payload);
    return data;
  }
};

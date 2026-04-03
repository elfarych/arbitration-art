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
  max_trades: number;
  open_ticks: number;
  close_ticks: number;
  primary_leverage: number;
  secondary_leverage: number;
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
  }
};

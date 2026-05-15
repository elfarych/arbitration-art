import { api } from 'boot/axios';

// Mirrors apps/bots/services/pnl.aggregate_pnl response. Decimal-like numbers
// are sent by the backend as strings to preserve precision; the UI parses them
// with parseFloat only at the display boundary.

export interface PnlBucket {
  profit_usdt: string;
  trades_count: number;
  wins: number;
  losses: number;
}

export interface PnlTotal extends PnlBucket {
  win_rate: number;
}

export interface PnlByBotEntry extends PnlBucket {
  bot_id: number;
  coin: string;
  trade_mode: 'real' | 'emulator';
  primary_exchange: string;
  secondary_exchange: string;
  is_active: boolean;
  real: PnlBucket;
  emulator: PnlBucket;
}

export interface PnlSummary {
  from: string | null;
  to: string | null;
  total: PnlTotal;
  real: PnlBucket;
  emulator: PnlBucket;
  by_bot: PnlByBotEntry[];
}

export interface PnlQuery {
  from?: string | null;
  to?: string | null;
  bot_id?: number;
  trade_mode?: 'real' | 'emulator';
}

function buildQuery(params: PnlQuery): string {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.bot_id !== undefined) qs.set('bot_id', String(params.bot_id));
  if (params.trade_mode) qs.set('trade_mode', params.trade_mode);
  const tail = qs.toString();
  return tail ? `?${tail}` : '';
}

export const pnlApi = {
  async summary(params: PnlQuery = {}): Promise<PnlSummary> {
    const { data } = await api.get<PnlSummary>(`/bots/pnl/${buildQuery(params)}`);
    return data;
  },
};

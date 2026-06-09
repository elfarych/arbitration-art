import { api } from 'boot/axios';

// Per-user price alerts live in Django (authed `api` instance, JWT), like
// favorites. Unlike the singleton notification-config, this is a collection
// (CRUD by id): a user pins many target prices, usually by right-clicking a price
// on the screener chart. `direction` is inferred from the click position vs the
// current price (above = price must rise to the target, below = must fall).

export type PriceDirection = 'above' | 'below';

export interface PriceNotification {
  id: number;
  symbol: string;
  targetPrice: number;
  direction: PriceDirection;
  enabled: boolean;
  // Set when a one-shot alert has fired (then enabled is false); null while armed.
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceNotificationInput {
  symbol: string;
  targetPrice: number;
  direction: PriceDirection;
  enabled?: boolean;
}

// DRF may return a bare array or a paginated { results } envelope; price alerts
// are unpaginated, but tolerate both so a pagination change can't break the UI.
function unwrapList<T>(data: T[] | { results?: T[] }): T[] {
  return Array.isArray(data) ? data : (data.results ?? []);
}

export const priceNotificationsApi = {
  // All price alerts of the current user (GET /levels/price-notifications/).
  async list(): Promise<PriceNotification[]> {
    const { data } = await api.get<PriceNotification[] | { results?: PriceNotification[] }>(
      '/levels/price-notifications/',
    );
    return unwrapList(data);
  },

  // Create one (POST /levels/price-notifications/).
  async create(input: PriceNotificationInput): Promise<PriceNotification> {
    const { data } = await api.post<PriceNotification>('/levels/price-notifications/', {
      ...input,
      symbol: input.symbol.toUpperCase(),
    });
    return data;
  },

  // Update fields by id (PATCH /levels/price-notifications/:id/) — re-arm (enabled),
  // move the target, etc.
  async update(id: number, patch: Partial<PriceNotificationInput>): Promise<PriceNotification> {
    const { data } = await api.patch<PriceNotification>(
      `/levels/price-notifications/${id}/`,
      patch,
    );
    return data;
  },

  // Delete by id (DELETE /levels/price-notifications/:id/).
  async remove(id: number): Promise<void> {
    await api.delete(`/levels/price-notifications/${id}/`);
  },
};

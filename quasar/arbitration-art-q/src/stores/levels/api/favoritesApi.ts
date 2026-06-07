import { api } from 'boot/axios';

// Per-user favorite coins live in Django (authed `api` instance, JWT), unlike the
// screener which talks to levels-api directly. The viewset is addressed by symbol
// (DELETE /levels/favorites/BTCUSDT/) and returns the full list unpaginated.

export interface FavoriteCoin {
  id: number;
  symbol: string;
  createdAt: string;
}

// DRF may return a bare array or a paginated { results } envelope; favorites are
// unpaginated, but tolerate both so a pagination change can't break the screener.
function unwrapList<T>(data: T[] | { results?: T[] }): T[] {
  return Array.isArray(data) ? data : (data.results ?? []);
}

export const favoritesApi = {
  // All favorites of the current user (GET /levels/favorites/).
  async list(): Promise<FavoriteCoin[]> {
    const { data } = await api.get<FavoriteCoin[] | { results?: FavoriteCoin[] }>(
      '/levels/favorites/',
    );
    return unwrapList(data);
  },

  // Add a favorite (POST /levels/favorites/). Idempotent server-side: re-adding an
  // existing favorite returns it instead of erroring.
  async add(symbol: string): Promise<FavoriteCoin> {
    const { data } = await api.post<FavoriteCoin>('/levels/favorites/', {
      symbol: symbol.toUpperCase(),
    });
    return data;
  },

  // Remove a favorite by symbol (DELETE /levels/favorites/:symbol/).
  async remove(symbol: string): Promise<void> {
    await api.delete(`/levels/favorites/${symbol.toUpperCase()}/`);
  },
};

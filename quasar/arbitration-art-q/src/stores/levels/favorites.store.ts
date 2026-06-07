import { defineStore } from 'pinia';
import { favoritesApi } from './api/favoritesApi';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Per-user favorite coins for the levels screener. Backed by Django
// (./api/favoritesApi). The set of symbols is the source of truth for the star
// toggle on each chart card and for the "pin favorites to the top" filter (see
// the `entries` getter in levels.store). Symbols are stored uppercase to match
// the screener.

interface FavoritesState {
  // Favorite symbols (uppercase). A Set for O(1) membership checks per card.
  symbols: Set<string>;
  loaded: boolean;
  loading: boolean;
  // Symbols with an in-flight add/remove — used to disable the toggle and guard
  // against a double click landing two requests.
  pending: Set<string>;
  error: string | null;
}

export const useFavoritesStore = defineStore('levelsFavorites', {
  state: (): FavoritesState => ({
    symbols: new Set(),
    loaded: false,
    loading: false,
    pending: new Set(),
    error: null,
  }),

  getters: {
    isFavorite: (state) => (symbol: string): boolean => state.symbols.has(symbol.toUpperCase()),
    isPending: (state) => (symbol: string): boolean => state.pending.has(symbol.toUpperCase()),
    count: (state): number => state.symbols.size,
  },

  actions: {
    // Load the favorites list once (idempotent while a load is in flight).
    async load() {
      if (this.loading) return;
      this.loading = true;
      this.error = null;
      try {
        const favorites = await favoritesApi.list();
        this.symbols = new Set(favorites.map((f) => f.symbol.toUpperCase()));
        this.loaded = true;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить избранное');
      } finally {
        this.loading = false;
      }
    },

    // Optimistic add/remove: flip the local set immediately for instant feedback,
    // call the API, roll back on failure. `pending` blocks a second toggle of the
    // same symbol until the request settles.
    async toggle(symbol: string) {
      const sym = symbol.toUpperCase();
      if (this.pending.has(sym)) return;
      const wasFavorite = this.symbols.has(sym);
      this.pending.add(sym);
      if (wasFavorite) this.symbols.delete(sym);
      else this.symbols.add(sym);
      this.error = null;
      try {
        if (wasFavorite) await favoritesApi.remove(sym);
        else await favoritesApi.add(sym);
      } catch (e) {
        // Roll back the optimistic change.
        if (wasFavorite) this.symbols.add(sym);
        else this.symbols.delete(sym);
        this.error = extractApiErrorMessage(e, 'Не удалось обновить избранное');
        throw e;
      } finally {
        this.pending.delete(sym);
      }
    },
  },
});

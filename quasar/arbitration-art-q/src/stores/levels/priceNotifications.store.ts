import { defineStore } from 'pinia';
import {
  priceNotificationsApi,
  type PriceNotification,
  type PriceNotificationInput,
} from './api/priceNotificationsApi';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Per-user price alerts for the levels screener, backed by Django
// (./api/priceNotificationsApi). The list is the source of truth for the price
// lines overlaid on each chart card and for the "По цене" tab in the
// notifications dialog. Updates/removes are optimistic with rollback (mirrors
// favorites.store); create awaits the server to obtain the row id.

interface PriceNotificationsState {
  items: PriceNotification[];
  loaded: boolean;
  loading: boolean;
  creating: boolean;
  // Ids with an in-flight update/remove — used to disable per-row controls and
  // guard against a double click landing two requests.
  pending: Set<number>;
  error: string | null;
}

export const usePriceNotificationsStore = defineStore('levelsPriceNotifications', {
  state: (): PriceNotificationsState => ({
    items: [],
    loaded: false,
    loading: false,
    creating: false,
    pending: new Set(),
    error: null,
  }),

  getters: {
    // Alerts for one symbol (case-insensitive), newest first by store order.
    bySymbol: (state) => (symbol: string): PriceNotification[] => {
      const sym = symbol.toUpperCase();
      return state.items.filter((n) => n.symbol === sym);
    },
    isPending: (state) => (id: number): boolean => state.pending.has(id),
    count: (state): number => state.items.length,
  },

  actions: {
    // Load the list once (idempotent while a load is in flight).
    async load() {
      if (this.loading) return;
      this.loading = true;
      this.error = null;
      try {
        this.items = await priceNotificationsApi.list();
        this.loaded = true;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить ценовые уведомления');
      } finally {
        this.loading = false;
      }
    },

    // Create one (await the server for the id, then prepend). Returns the created
    // row, or throws so the caller can surface a toast.
    async create(input: PriceNotificationInput): Promise<PriceNotification> {
      this.creating = true;
      this.error = null;
      try {
        const created = await priceNotificationsApi.create(input);
        this.items.unshift(created);
        return created;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось создать ценовое уведомление');
        throw e;
      } finally {
        this.creating = false;
      }
    },

    // Optimistically patch a row, reconcile with the server response, roll back on
    // failure. Used to re-arm (enabled) or move a target.
    async update(id: number, patch: Partial<PriceNotificationInput>) {
      if (this.pending.has(id)) return;
      const idx = this.items.findIndex((n) => n.id === id);
      const current = idx === -1 ? undefined : this.items[idx];
      if (!current) return;
      const previous = { ...current };
      this.pending.add(id);
      this.error = null;
      // `current` is the array element by reference — mutating it updates the list.
      Object.assign(current, patch);
      try {
        const updated = await priceNotificationsApi.update(id, patch);
        const at = this.items.findIndex((n) => n.id === id);
        if (at !== -1) this.items[at] = updated;
      } catch (e) {
        const at = this.items.findIndex((n) => n.id === id);
        if (at !== -1) this.items[at] = previous;
        this.error = extractApiErrorMessage(e, 'Не удалось обновить уведомление');
        throw e;
      } finally {
        this.pending.delete(id);
      }
    },

    // Optimistically remove a row, roll back on failure.
    async remove(id: number) {
      if (this.pending.has(id)) return;
      const idx = this.items.findIndex((n) => n.id === id);
      const removed = idx === -1 ? undefined : this.items[idx];
      if (!removed) return;
      this.pending.add(id);
      this.error = null;
      this.items.splice(idx, 1);
      try {
        await priceNotificationsApi.remove(id);
      } catch (e) {
        this.items.splice(idx, 0, removed);
        this.error = extractApiErrorMessage(e, 'Не удалось удалить уведомление');
        throw e;
      } finally {
        this.pending.delete(id);
      }
    },

    // Remove all fired (disabled) alerts at once. Best-effort: deletes them in
    // parallel, drops the ones that succeeded, keeps any that failed, and reports
    // a partial-failure message. No DELETE-by-id rollback needed — failures stay.
    async removeFired() {
      const firedIds = this.items.filter((n) => !n.enabled).map((n) => n.id);
      if (firedIds.length === 0) return;
      firedIds.forEach((id) => this.pending.add(id));
      this.error = null;
      const results = await Promise.allSettled(
        firedIds.map((id) => priceNotificationsApi.remove(id)),
      );
      const failed = new Set<number>();
      results.forEach((result, i) => {
        const id = firedIds[i];
        if (id !== undefined && result.status === 'rejected') failed.add(id);
      });
      // Drop the successfully-deleted fired alerts; keep active and any that failed.
      this.items = this.items.filter((n) => n.enabled || failed.has(n.id));
      firedIds.forEach((id) => this.pending.delete(id));
      if (failed.size > 0) {
        this.error = 'Не удалось удалить некоторые уведомления';
      }
    },
  },
});

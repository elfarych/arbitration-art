import { defineStore } from 'pinia';
import {
  notificationsApi,
  type NotificationConfig,
  type NotificationConfigInput,
} from './api/notificationsApi';
import { LEVELS_MIN_VOLUME } from './levels.store';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Per-user level-notification config for the screener, backed by Django
// (./api/notificationsApi). Loaded once for the notifications dialog; saving
// replaces the cached config with the server response.

const DEFAULT_CONFIG: NotificationConfig = {
  enabled: false,
  onlyFavorites: false,
  timeframe: '1m',
  natrMultiplier: 0.3,
  minGap: 12,
  minVolume: LEVELS_MIN_VOLUME,
  distanceMode: 'pct',
  distanceValue: 1,
  chatId: '',
};

interface NotificationsState {
  config: NotificationConfig;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export const useNotificationsStore = defineStore('levelsNotifications', {
  state: (): NotificationsState => ({
    config: { ...DEFAULT_CONFIG },
    loaded: false,
    loading: false,
    saving: false,
    error: null,
  }),

  actions: {
    // Load the config once (idempotent while a load is in flight).
    async load() {
      if (this.loading) return;
      this.loading = true;
      this.error = null;
      try {
        this.config = await notificationsApi.get();
        this.loaded = true;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось загрузить настройки уведомлений');
      } finally {
        this.loading = false;
      }
    },

    // Persist the config; on success the server response becomes the cached config.
    async save(config: NotificationConfigInput) {
      this.saving = true;
      this.error = null;
      try {
        this.config = await notificationsApi.save(config);
        this.loaded = true;
      } catch (e) {
        this.error = extractApiErrorMessage(e, 'Не удалось сохранить настройки уведомлений');
        throw e;
      } finally {
        this.saving = false;
      }
    },
  },
});

import { api } from 'boot/axios';

// Per-user level-notification config lives in Django (authed `api`, JWT), like
// favorites — not on the non-authed levelsApi. It is a singleton per user, so the
// endpoint is a plain path (no id): GET to read, PUT to update.

export type DistanceMode = 'pct' | 'natr';

export interface NotificationConfig {
  enabled: boolean;
  onlyFavorites: boolean;
  timeframe: string;
  natrMultiplier: number;
  minGap: number;
  // Minimum USDT turnover (raw USDT); 0 = off.
  minVolume: number;
  distanceMode: DistanceMode;
  distanceValue: number;
  chatId: string;
  updatedAt?: string;
}

// Editable subset sent on save (server ignores read-only updatedAt anyway).
export type NotificationConfigInput = Omit<NotificationConfig, 'updatedAt'>;

export const notificationsApi = {
  // Current user's config (GET /levels/notification-config/). Django creates it
  // lazily, so this always returns a row.
  async get(): Promise<NotificationConfig> {
    const { data } = await api.get<NotificationConfig>('/levels/notification-config/');
    return data;
  },

  // Update the config (PUT /levels/notification-config/).
  async save(config: NotificationConfigInput): Promise<NotificationConfig> {
    const { data } = await api.put<NotificationConfig>('/levels/notification-config/', config);
    return data;
  },
};

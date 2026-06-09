/** Fetch active level-notification configs from Django.

Mirrors the engine's service-to-service pattern: GET with the shared
`X-Service-Token` header, no JWT. The endpoint returns only enabled configs that
have a chat_id, each with the owner's favorite symbols. */

import type { Logger } from '../utils/logger';
import { requestJson, withRetry } from '../utils/http';

export type DistanceMode = 'pct' | 'natr';

/** One active config as served by Django `/levels/notification-configs/`. */
export interface NotificationConfig {
  ownerId: number;
  enabled: boolean;
  onlyFavorites: boolean;
  timeframe: string;
  natrMultiplier: number;
  minGap: number;
  minVolume: number;
  distanceMode: DistanceMode;
  distanceValue: number;
  chatId: string;
  favorites: string[];
}

interface ConfigsResponse {
  configs: NotificationConfig[];
}

export type PriceDirection = 'above' | 'below';

/** One active price alert as served by Django `/levels/service/price-notifications/`.
 * `chatId` is reused from the owner's LevelNotificationConfig (the endpoint only
 * returns alerts whose owner has one). */
export interface PriceNotification {
  id: number;
  ownerId: number;
  symbol: string;
  targetPrice: number;
  direction: PriceDirection;
  chatId: string;
}

interface PriceNotificationsResponse {
  notifications: PriceNotification[];
}

export class DjangoClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly apiUrl: string,
    serviceToken: string,
    private readonly logger: Logger,
  ) {
    this.headers = { 'X-Service-Token': serviceToken };
  }

  /** All active notification configs; retries on transient failures. */
  async getActiveConfigs(): Promise<NotificationConfig[]> {
    return withRetry(
      'getActiveConfigs',
      async () => {
        const data = await requestJson<ConfigsResponse>(
          `${this.apiUrl}/levels/notification-configs/`,
          { method: 'GET', headers: this.headers },
        );
        return data?.configs ?? [];
      },
      this.logger,
    );
  }

  /** All active (enabled, deliverable) price alerts; retries on transient failures. */
  async getActivePriceNotifications(): Promise<PriceNotification[]> {
    return withRetry(
      'getActivePriceNotifications',
      async () => {
        const data = await requestJson<PriceNotificationsResponse>(
          `${this.apiUrl}/levels/service/price-notifications/`,
          { method: 'GET', headers: this.headers },
        );
        return data?.notifications ?? [];
      },
      this.logger,
    );
  }

  /** Mark a price alert as fired (one-shot disable). Idempotent on the server. */
  async markPriceNotificationTriggered(id: number): Promise<void> {
    await withRetry(
      'markPriceNotificationTriggered',
      async () => {
        await requestJson<void>(
          `${this.apiUrl}/levels/service/price-notifications/${id}/trigger/`,
          { method: 'POST', headers: this.headers, expectedStatuses: [200] },
        );
      },
      this.logger,
    );
  }
}

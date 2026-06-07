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
}

/** Per-config notification de-duplication state, owned by the notifier in Redis.

Without this a coin parked near a level would alert every tick (~6×/min). Policy:
edge-trigger on zone entry + cooldown per (owner, tf, symbol, level). The caller
invokes `shouldNotify` only when the price is inside the zone; we alert when there
is no recent alert for this level, when a *different* level entered the zone, or
when the cooldown has elapsed. State is keyed per (owner, tf, symbol), carries the
level price + last-alert time, and is TTL'd to the cooldown so vanished coins and
elapsed cooldowns clean themselves up. The service never writes alert state back
to Django. */

import type { Redis } from 'ioredis';

interface NotifyState {
  levelPrice: number;
  notifiedAt: number;
}

// Level prices can micro-shift between recomputations; treat levels within this
// relative band as the same level, so a sub-band wobble isn't seen as a new one.
const SAME_LEVEL_TOLERANCE = 0.0015; // 0.15%

export class NotifyStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly cooldownMs: number,
  ) {}

  private key(ownerId: number, timeframe: string, symbol: string): string {
    return `level-notifier:state:${ownerId}:${timeframe}:${symbol}`;
  }

  /**
   * Decide whether to alert for the nearest in-zone level and, if so, record the
   * alert. Call only when the price is inside the user's distance zone.
   */
  async shouldNotify(
    ownerId: number,
    timeframe: string,
    symbol: string,
    levelPrice: number,
    now: number,
  ): Promise<boolean> {
    const key = this.key(ownerId, timeframe, symbol);
    const state = parseState(await this.redis.get(key));

    const sameLevel =
      state !== null && Math.abs(state.levelPrice - levelPrice) <= levelPrice * SAME_LEVEL_TOLERANCE;
    const cooldownElapsed = state === null || now - state.notifiedAt >= this.cooldownMs;

    if (state === null || !sameLevel || cooldownElapsed) {
      const next: NotifyState = { levelPrice, notifiedAt: now };
      await this.redis.set(key, JSON.stringify(next), 'PX', this.cooldownMs);
      return true;
    }
    return false;
  }
}

function parseState(raw: string | null): NotifyState | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NotifyState>;
    if (typeof parsed.levelPrice === 'number' && typeof parsed.notifiedAt === 'number') {
      return { levelPrice: parsed.levelPrice, notifiedAt: parsed.notifiedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/** Anti-double-fire guard for one-shot price alerts, owned by the notifier in Redis.

Price alerts are one-shot: after firing, the notifier POSTs Django to set
`enabled=false`, so the alert drops out of the service feed — that disable is the
real de-dup. But there is a brief window between sending the Telegram message and
the next feed read where the alert is still `enabled=true`; without a guard a
second tick (and a price still past the target) would re-fire it. This store sets
a short-lived key per alert id right before sending, so a concurrent/next tick
within the window skips it. The key TTLs out, so a re-armed alert (Django clears
`triggered_at` and flips `enabled` back on) is not blocked once the window passes.
The service never writes alert state back to Django beyond the one-shot trigger. */

import type { Redis } from 'ioredis';

export class PriceNotifyStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly guardMs: number,
  ) {}

  private key(id: number): string {
    return `level-notifier:price-state:${id}`;
  }

  /**
   * Reserve the right to fire this alert: returns true and sets the guard if no
   * recent fire is recorded, false if one is. `NX` makes the check-and-set atomic
   * against a concurrent tick on the same Redis.
   */
  async shouldFire(id: number, now: number): Promise<boolean> {
    const result = await this.redis.set(
      this.key(id),
      String(now),
      'PX',
      this.guardMs,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * Release a reserved guard so the next tick can retry. Called when delivery
   * failed (no Django disable happened, so the guard would otherwise needlessly
   * block re-fire for the whole guard window).
   */
  async release(id: number): Promise<void> {
    await this.redis.del(this.key(id));
  }
}

/** Per-minute request-weight limiter for Binance REST (self-contained).

MIRROR of art-level-screener/services/levels-api/src/binance/rate-limiter.ts —
keep in sync (see ../README.md). Identical logic; in the browser `observe()` is
never called because the `X-MBX-USED-WEIGHT-1M` header is not CORS-exposed, so
the limiter self-accounts from the static request weights only (conservative).

Requests run sequentially (concurrency = 1). Each request reserves its weight up
front; when the minute budget is spent it waits until the next minute (Binance
resets the weight counter every minute). */

const SAFETY_RATIO = 0.8;

export class WeightRateLimiter {
  private readonly budget: number;
  private used = 0;
  private windowMinute = currentMinute();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(weightLimitPerMin: number, safetyRatio: number = SAFETY_RATIO) {
    this.budget = Math.max(1, Math.floor(weightLimitPerMin * safetyRatio));
  }

  /** Queue a task with a given weight onto the sequential pipeline. */
  run<T>(weight: number, task: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      await this.gate(weight);
      return task();
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Sync the counter with the actual weight reported by the response header.
   * Unused in the browser (header not CORS-exposed); kept to mirror the source. */
  observe(usedWeight: number): void {
    if (Number.isFinite(usedWeight)) {
      this.used = Math.max(this.used, usedWeight);
    }
  }

  private async gate(weight: number): Promise<void> {
    this.rotateWindow();
    if (this.used + weight > this.budget) {
      await sleep(msUntilNextMinute());
      this.windowMinute = currentMinute();
      this.used = 0;
    }
    this.used += weight;
  }

  private rotateWindow(): void {
    const minute = currentMinute();
    if (minute !== this.windowMinute) {
      this.windowMinute = minute;
      this.used = 0;
    }
  }
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function msUntilNextMinute(): number {
  return 60_000 - (Date.now() % 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

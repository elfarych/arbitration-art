/** Лимитер веса REST-запросов Binance с поминутным окном.

Запросы выполняются последовательно (concurrency = 1) — это просто и безопасно
для лимитов. Перед каждым запросом резервируется его «вес»; если бюджет минуты
исчерпан, ожидание до начала следующей минуты (Binance сбрасывает счётчик веса
каждую минуту). Фактический использованный вес синхронизируется из заголовка
ответа `X-MBX-USED-WEIGHT-1M`. */

import { currentMinute, msUntilNextMinute, sleep } from '../utils/async';

const SAFETY_RATIO = 0.8;

export class WeightRateLimiter {
  private readonly budget: number;
  private used = 0;
  private windowMinute = currentMinute();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(weightLimitPerMin: number, safetyRatio: number = SAFETY_RATIO) {
    this.budget = Math.max(1, Math.floor(weightLimitPerMin * safetyRatio));
  }

  /** Поставить задачу с заданным весом в последовательную очередь. */
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

  /** Синхронизировать счётчик с фактическим весом из заголовка ответа. */
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

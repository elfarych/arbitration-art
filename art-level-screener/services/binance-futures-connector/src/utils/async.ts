/** Мелкие асинхронные/временные утилиты. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Разбить массив на группы по `size` элементов. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error('chunk: size должен быть > 0');
  }
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/** Номер текущей минуты (для оконного учёта веса REST). */
export function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

/** Миллисекунды до начала следующей минуты. */
export function msUntilNextMinute(): number {
  return 60_000 - (Date.now() % 60_000);
}

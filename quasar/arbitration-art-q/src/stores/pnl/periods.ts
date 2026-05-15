// Period helpers for the PnL views. All ranges are computed in the user's
// local timezone (browser), then converted to ISO with offset so Django's
// `closed_at__gte/__lte` filters compare apples-to-apples regardless of how
// the server is configured (settings.TIME_ZONE defaults to Asia/Almaty, but
// the deployment may live in a different region than the user).

export type PnlPeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'prev_month' | 'year' | 'all' | 'custom';

export interface PnlRange {
  from: string | null;
  to: string | null;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function rangeForPeriod(period: PnlPeriodKey, custom?: PnlRange): PnlRange {
  const now = new Date();
  switch (period) {
    case 'today':
      return { from: toIso(startOfDay(now)), to: toIso(endOfDay(now)) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: toIso(startOfDay(y)), to: toIso(endOfDay(y)) };
    }
    case 'week': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: toIso(startOfDay(start)), to: toIso(endOfDay(now)) };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toIso(startOfDay(start)), to: toIso(endOfDay(now)) };
    }
    case 'prev_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toIso(startOfDay(start)), to: toIso(endOfDay(end)) };
    }
    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: toIso(startOfDay(start)), to: toIso(endOfDay(now)) };
    }
    case 'all':
      return { from: null, to: null };
    case 'custom':
      return { from: custom?.from ?? null, to: custom?.to ?? null };
  }
}

export const PERIOD_LABELS: Record<PnlPeriodKey, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Последние 7 дней',
  month: 'Текущий месяц',
  prev_month: 'Прошлый месяц',
  year: 'С начала года',
  all: 'За всё время',
  custom: 'Свой период',
};

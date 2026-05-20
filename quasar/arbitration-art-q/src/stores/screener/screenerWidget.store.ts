import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { binanceApi } from 'src/stores/exchanges/api/binanceApi';
import { binanceSpotApi } from 'src/stores/exchanges/api/binanceSpotApi';
import { mexcApi } from 'src/stores/exchanges/api/mexcApi';
import { bybitApi } from 'src/stores/exchanges/api/bybitApi';

export type WidgetOrderType = 'buy' | 'sell';

export interface WidgetSettings {
  primaryExchange: string;
  secondaryExchange: string;
  orderType: WidgetOrderType;
  minVolume: number;
  topCount: number;
  notifyOnNew: boolean;
}

export interface WidgetResult {
  coin: string;
  spread: number;
  primaryPrice: number;
  secondaryPrice: number;
  // 24h turnover in USDT. The widget surfaces the min of the two legs — that's
  // the practical liquidity ceiling for cross-exchange arbitrage.
  primaryQuoteVolume: number;
  secondaryQuoteVolume: number;
  minQuoteVolume: number;
  position: number;
  appearances: number;
}

export interface WidgetNotification {
  id: number;
  coin: string;
  position: number;
  appearances: number;
  createdAt: number;
}

const apiMap: Record<string, { getAllTickers(): Promise<Record<string, { bid: number; ask: number; quoteVolume: number }>> }> = {
  binance_futures: binanceApi,
  binance_spot: binanceSpotApi,
  mexc_futures: mexcApi,
  bybit_futures: bybitApi,
};

const STORAGE_KEYS = {
  settings: 'screenerWidget.settings',
  appearances: 'screenerWidget.appearances',
  lastTop: 'screenerWidget.lastTop',
  expanded: 'screenerWidget.expanded',
} as const;

const SCAN_INTERVAL_MS = 30000;
// Notifications persist until the user dismisses them — keep a hard cap so
// long sessions don't accumulate unbounded state if many new coins keep
// rotating into the top.
const MAX_NOTIFICATIONS = 200;

const safeParse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const isValidSettings = (s: unknown): s is WidgetSettings => {
  if (!s || typeof s !== 'object') return false;
  const v = s as Partial<WidgetSettings>;
  return (
    typeof v.primaryExchange === 'string' &&
    typeof v.secondaryExchange === 'string' &&
    (v.orderType === 'buy' || v.orderType === 'sell') &&
    typeof v.minVolume === 'number' &&
    typeof v.topCount === 'number' &&
    typeof v.notifyOnNew === 'boolean'
  );
};

export const useScreenerWidgetStore = defineStore('screenerWidget', () => {
  const storedSettings = safeParse<WidgetSettings>(localStorage.getItem(STORAGE_KEYS.settings));
  const storedAppearances = safeParse<Record<string, number>>(localStorage.getItem(STORAGE_KEYS.appearances)) ?? {};
  const storedLastTop = safeParse<string[]>(localStorage.getItem(STORAGE_KEYS.lastTop)) ?? [];

  const settings = ref<WidgetSettings | null>(isValidSettings(storedSettings) ? storedSettings : null);
  const expanded = ref<boolean>(localStorage.getItem(STORAGE_KEYS.expanded) === '1');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const results = ref<WidgetResult[]>([]);
  const appearances = ref<Record<string, number>>(storedAppearances);
  const lastTop = ref<string[]>(storedLastTop);
  const notifications = ref<WidgetNotification[]>([]);
  const lastScanAt = ref<number | null>(null);

  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let notifIdSeq = 1;

  const isConfigured = computed(() => settings.value !== null);

  const persistSettings = () => {
    if (settings.value) {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings.value));
    } else {
      localStorage.removeItem(STORAGE_KEYS.settings);
    }
  };

  const persistAppearances = () => {
    localStorage.setItem(STORAGE_KEYS.appearances, JSON.stringify(appearances.value));
  };

  const persistLastTop = () => {
    localStorage.setItem(STORAGE_KEYS.lastTop, JSON.stringify(lastTop.value));
  };

  watch(expanded, (v) => {
    localStorage.setItem(STORAGE_KEYS.expanded, v ? '1' : '0');
  });

  const toggleExpanded = () => {
    expanded.value = !expanded.value;
  };

  const saveSettings = (next: WidgetSettings) => {
    const isFirstTime = settings.value === null;
    // Reset appearance counters whenever the market context shifts: pair,
    // direction or top size. With a different topN the very notion of "in the
    // top" changes, so historical counts collected at a different N become
    // misleading.
    const contextChanged =
      !isFirstTime &&
      settings.value !== null &&
      (settings.value.primaryExchange !== next.primaryExchange ||
        settings.value.secondaryExchange !== next.secondaryExchange ||
        settings.value.orderType !== next.orderType ||
        settings.value.topCount !== next.topCount);

    settings.value = { ...next };
    persistSettings();

    if (contextChanged) {
      appearances.value = {};
      lastTop.value = [];
      persistAppearances();
      persistLastTop();
      results.value = [];
    }

    void scanOnce();
    startPolling();
  };

  const resetSettings = () => {
    settings.value = null;
    appearances.value = {};
    lastTop.value = [];
    results.value = [];
    notifications.value = [];
    persistSettings();
    persistAppearances();
    persistLastTop();
    stopPolling();
  };

  const dismissNotification = (id: number) => {
    notifications.value = notifications.value.filter((n) => n.id !== id);
  };

  const dismissAllNotifications = () => {
    notifications.value = [];
  };

  const pushNotification = (coin: string, position: number, count: number) => {
    const id = notifIdSeq++;
    const note: WidgetNotification = {
      id,
      coin,
      position,
      appearances: count,
      createdAt: Date.now(),
    };
    notifications.value = [note, ...notifications.value].slice(0, MAX_NOTIFICATIONS);
  };

  const scanOnce = async (): Promise<void> => {
    const cfg = settings.value;
    if (!cfg) return;
    if (cfg.primaryExchange === cfg.secondaryExchange) {
      error.value = 'Биржи должны отличаться';
      return;
    }
    const pApi = apiMap[cfg.primaryExchange];
    const sApi = apiMap[cfg.secondaryExchange];
    if (!pApi || !sApi) {
      error.value = 'Биржа не поддерживается';
      return;
    }
    // Re-entry guard: a manual refresh fired while a poll-scan is still in
    // flight could otherwise double-increment counters and corrupt lastTop.
    if (loading.value) return;

    loading.value = true;
    error.value = null;
    try {
      const [pData, sData] = await Promise.all([pApi.getAllTickers(), sApi.getAllTickers()]);

      // Both adapters swallow REST failures and return {}. If either feed is
      // empty we treat the whole scan as a no-op: mutating lastTop with []
      // here would cause the next successful scan to mark every top coin as
      // "new" and spam notifications + bogus counter bumps.
      if (Object.keys(pData).length === 0 || Object.keys(sData).length === 0) {
        error.value = 'Не удалось получить данные с биржи';
        return;
      }

      const matched: Omit<WidgetResult, 'position' | 'appearances'>[] = [];
      const threshold = cfg.minVolume > 0 ? cfg.minVolume : 0;

      for (const coin in pData) {
        const p = pData[coin];
        const s = sData[coin];
        if (!p || !s) continue;
        if (!p.bid || !p.ask || !s.bid || !s.ask) continue;

        const pVol = p.quoteVolume ?? 0;
        const sVol = s.quoteVolume ?? 0;
        const minVol = Math.min(pVol, sVol);

        if (threshold > 0 && minVol < threshold) continue;

        let spread: number;
        let pPrice: number;
        let sPrice: number;
        if (cfg.orderType === 'buy') {
          spread = ((s.bid - p.ask) / p.ask) * 100;
          pPrice = p.ask;
          sPrice = s.bid;
        } else {
          spread = ((p.bid - s.ask) / s.ask) * 100;
          pPrice = p.bid;
          sPrice = s.ask;
        }

        matched.push({
          coin,
          spread,
          primaryPrice: pPrice,
          secondaryPrice: sPrice,
          primaryQuoteVolume: pVol,
          secondaryQuoteVolume: sVol,
          minQuoteVolume: minVol,
        });
      }

      matched.sort((a, b) => b.spread - a.spread);
      const top = matched.slice(0, Math.max(1, cfg.topCount));
      const topCoins = top.map((r) => r.coin);
      const prevSet = new Set(lastTop.value);
      // First scan after fresh setup / context change has an empty prev set,
      // so every coin in the new top looks "new". Counters legitimately go to
      // 1 (the coin is in our tracked top for the first time), but firing N
      // notifications at once would be pure noise — the user just changed the
      // settings and obviously expects a new top.
      const suppressNotifications = prevSet.size === 0;

      // Increment appearance counters for coins entering the top this scan
      // (either brand-new or returning after dropping out).
      const newEntries: { coin: string; position: number; count: number }[] = [];
      top.forEach((row, idx) => {
        if (!prevSet.has(row.coin)) {
          const next = (appearances.value[row.coin] ?? 0) + 1;
          appearances.value[row.coin] = next;
          newEntries.push({ coin: row.coin, position: idx + 1, count: next });
        }
      });

      results.value = top.map((row, idx) => ({
        ...row,
        position: idx + 1,
        appearances: appearances.value[row.coin] ?? 0,
      }));

      lastTop.value = topCoins;
      lastScanAt.value = Date.now();
      persistAppearances();
      persistLastTop();

      if (cfg.notifyOnNew && !suppressNotifications) {
        for (const entry of newEntries) {
          pushNotification(entry.coin, entry.position, entry.count);
        }
      }
    } catch (e) {
      console.error('Screener widget scan failed:', e);
      error.value = 'Не удалось получить данные с биржи';
    } finally {
      loading.value = false;
    }
  };

  const startPolling = () => {
    stopPolling();
    if (!settings.value) return;
    scanTimer = setInterval(() => {
      void scanOnce();
    }, SCAN_INTERVAL_MS);
  };

  const stopPolling = () => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  };

  const init = () => {
    if (settings.value) {
      void scanOnce();
      startPolling();
    }
  };

  return {
    settings,
    expanded,
    loading,
    error,
    results,
    appearances,
    notifications,
    lastScanAt,
    isConfigured,
    toggleExpanded,
    saveSettings,
    resetSettings,
    dismissNotification,
    dismissAllNotifications,
    scanOnce,
    startPolling,
    stopPolling,
    init,
  };
});

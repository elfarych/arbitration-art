import { reactive } from 'vue';
import { binanceApi, type TickerData } from '../services/exchanges/binanceApi';
import { mexcApi } from '../services/exchanges/mexcApi';

export interface SpreadSnapshot {
  timestamp: number;
  openSpread: number;
  closeSpread: number;
}

export interface SpreadStats {
  current: SpreadSnapshot | null;
  minOpen: number;
  maxOpen: number;
  minClose: number;
  maxClose: number;
  history: SpreadSnapshot[];
  loading: boolean;
  primaryBid: number;
  primaryAsk: number;
  secondaryBid: number;
  secondaryAsk: number;
  primaryVolume: number;
  secondaryVolume: number;
}

const MAX_HISTORY = 200;

class SpreadMonitorManager {
  private monitors = new Map<number, { stats: SpreadStats; closePrimary: () => void; closeSecondary: () => void }>();

  private getInitialStats(): SpreadStats {
    return {
      current: null,
      minOpen: Infinity,
      maxOpen: -Infinity,
      minClose: Infinity,
      maxClose: -Infinity,
      history: [],
      loading: true,
      primaryBid: 0,
      primaryAsk: 0,
      secondaryBid: 0,
      secondaryAsk: 0,
      primaryVolume: 0,
      secondaryVolume: 0,
    };
  }

  private streamTicker(coin: string, exchange: string, onMessage: (data: TickerData) => void) {
    if (exchange === 'binance_futures') return binanceApi.streamTicker(coin, onMessage);
    if (exchange === 'mexc_futures') return mexcApi.streamTicker(coin, onMessage);
    throw new Error(`Unsupported exchange: ${exchange}`);
  }

  start(botId: number, coin: string, primaryExchange: string, secondaryExchange: string): SpreadStats {
    const existing = this.monitors.get(botId);
    if (existing) return existing.stats;

    const stats = reactive(this.getInitialStats());
    let lastUpdate = 0;
    
    let primaryData: TickerData | null = null;
    let secondaryData: TickerData | null = null;

    const updateSpread = () => {
      const now = Date.now();
      if (!primaryData || !secondaryData || now - lastUpdate < 500) return;
      lastUpdate = now;

      const pBid = primaryData.bid;
      const pAsk = primaryData.ask;
      const sBid = secondaryData.bid;
      const sAsk = secondaryData.ask;

      if (!pBid || !sBid) return;

      const openSpread = ((pBid - sAsk) / sAsk) * 100;
      const closeSpread = ((sBid - pAsk) / pAsk) * 100;

      const snapshot: SpreadSnapshot = {
        timestamp: now,
        openSpread: Math.round(openSpread * 1000) / 1000,
        closeSpread: Math.round(closeSpread * 1000) / 1000,
      };

      stats.history.push(snapshot);
      if (stats.history.length > MAX_HISTORY) {
        stats.history.shift();
      }

      stats.current = snapshot;
      stats.minOpen = Math.min(stats.minOpen === Infinity ? snapshot.openSpread : stats.minOpen, snapshot.openSpread);
      stats.maxOpen = Math.max(stats.maxOpen === -Infinity ? snapshot.openSpread : stats.maxOpen, snapshot.openSpread);
      stats.minClose = Math.min(stats.minClose === Infinity ? snapshot.closeSpread : stats.minClose, snapshot.closeSpread);
      stats.maxClose = Math.max(stats.maxClose === -Infinity ? snapshot.closeSpread : stats.maxClose, snapshot.closeSpread);

      stats.loading = false;
      stats.primaryBid = pBid;
      stats.primaryAsk = pAsk;
      stats.secondaryBid = sBid;
      stats.secondaryAsk = sAsk;
      stats.primaryVolume = primaryData.volume;
      stats.secondaryVolume = secondaryData.volume;
    };

    const closePrimary = this.streamTicker(coin, primaryExchange, (data) => {
      primaryData = data;
      updateSpread();
    });

    const closeSecondary = this.streamTicker(coin, secondaryExchange, (data) => {
      secondaryData = data;
      updateSpread();
    });

    this.monitors.set(botId, { stats, closePrimary, closeSecondary });
    return stats;
  }

  stop(botId: number) {
    const monitor = this.monitors.get(botId);
    if (monitor) {
      monitor.closePrimary();
      monitor.closeSecondary();
      this.monitors.delete(botId);
    }
  }

  stopAll() {
    for (const [id] of this.monitors) {
      this.stop(id);
    }
  }

  getMonitor(botId: number): SpreadStats | undefined {
    return this.monitors.get(botId)?.stats;
  }
}

// Global Singleton for monitor
const monitorManager = new SpreadMonitorManager();

export function useSpreadMonitor() {
  return {
    start: monitorManager.start.bind(monitorManager),
    stop: monitorManager.stop.bind(monitorManager),
    stopAll: monitorManager.stopAll.bind(monitorManager),
    getMonitor: monitorManager.getMonitor.bind(monitorManager),
  };
}

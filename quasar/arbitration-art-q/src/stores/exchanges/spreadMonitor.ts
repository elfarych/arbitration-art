import { reactive } from 'vue';
import { binanceApi, type TickerData, type DepthData } from './api/binanceApi';
import { binanceSpotApi } from './api/binanceSpotApi';
import { mexcApi } from './api/mexcApi';
import { bybitApi } from './api/bybitApi';


export interface SpreadSnapshot {
  timestamp: number;
  openSpread: number;
  closeSpread: number;
  primaryExecPrice: number;
  secondaryExecPrice: number;
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
  insufficientExchanges: string[];
}

function calculateVWAP(book: [number, number][], amount: number): { vwap: number; insufficient: boolean } {
  if (!book || book.length === 0) return { vwap: 0, insufficient: true };
  if (amount <= 0) return { vwap: book[0]?.[0] || 0, insufficient: false };

  let accVolume = 0;
  let accValue = 0;

  for (const [price, qty] of book) {
    const remaining = amount - accVolume;
    if (qty >= remaining) {
      accVolume += remaining;
      accValue += remaining * price;
      break;
    } else {
      accVolume += qty;
      accValue += qty * price;
    }
  }

  const vwap = accVolume > 0 ? accValue / accVolume : 0;
  const insufficient = accVolume < amount * 0.9999;
  
  return { vwap, insufficient };
}

const MAX_HISTORY = 200;

class SpreadMonitorManager {
  private monitors = new Map<number, { 
    stats: SpreadStats; 
    closePrimary: () => void; 
    closeSecondary: () => void; 
    setAmount: (amount: number) => void; 
    setOrderType: (orderType: string) => void 
  }>();

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
      insufficientExchanges: [],
    };
  }

  private streamDepth(coin: string, exchange: string, onMessage: (data: DepthData) => void) {
    if (exchange === 'binance_futures') return binanceApi.streamDepth(coin, onMessage);
    if (exchange === 'binance_spot') return binanceSpotApi.streamDepth(coin, onMessage);
    if (exchange === 'mexc_futures') return mexcApi.streamDepth(coin, onMessage);
    if (exchange === 'bybit_futures') return bybitApi.streamDepth(coin, onMessage);
    throw new Error(`Unsupported exchange: ${exchange}`);
  }

  start(botId: number, coin: string, primaryExchange: string, secondaryExchange: string, initialAmount: number = 1, initialOrderType: string = 'sell'): SpreadStats {
    const existing = this.monitors.get(botId);
    if (existing) {
      existing.setAmount(initialAmount);
      existing.setOrderType(initialOrderType);
      return existing.stats;
    }

    const stats = reactive(this.getInitialStats());
    let lastUpdate = 0;
    
    let primaryData: DepthData | null = null;
    let secondaryData: DepthData | null = null;
    let currentAmount = initialAmount;
    let currentOrderType = initialOrderType;

    const updateSpread = (force = false) => {
      const now = Date.now();
      if (!primaryData || !secondaryData || (!force && now - lastUpdate < 500)) return;
      lastUpdate = now;

      const pBidRes = calculateVWAP(primaryData.bids, currentAmount);
      const pAskRes = calculateVWAP(primaryData.asks, currentAmount);
      const sBidRes = calculateVWAP(secondaryData.bids, currentAmount);
      const sAskRes = calculateVWAP(secondaryData.asks, currentAmount);

      const pBid = pBidRes.vwap;
      const pAsk = pAskRes.vwap;
      const sBid = sBidRes.vwap;
      const sAsk = sAskRes.vwap;

      if (!pBid || !sBid || !pAsk || !sAsk) return;

      let openSpread: number;
      let closeSpread: number;
      let primaryExecPrice: number;
      let secondaryExecPrice: number;

      if (currentOrderType === 'buy') {
        openSpread = ((sBid - pAsk) / pAsk) * 100;
        closeSpread = ((sAsk - pBid) / pBid) * 100;
        primaryExecPrice = pAsk;
        secondaryExecPrice = sBid;
      } else {
        openSpread = ((pBid - sAsk) / sAsk) * 100;
        closeSpread = ((pAsk - sBid) / sBid) * 100;
        primaryExecPrice = pBid;
        secondaryExecPrice = sAsk;
      }

      const snapshot: SpreadSnapshot = {
        timestamp: now,
        openSpread: Math.round(openSpread * 1000) / 1000,
        closeSpread: Math.round(closeSpread * 1000) / 1000,
        primaryExecPrice,
        secondaryExecPrice,
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

      const missingExchanges = new Set<string>();
      if (pBidRes.insufficient || pAskRes.insufficient) missingExchanges.add(primaryExchange);
      if (sBidRes.insufficient || sAskRes.insufficient) missingExchanges.add(secondaryExchange);
      stats.insufficientExchanges = Array.from(missingExchanges);
    };

    const closePrimary = this.streamDepth(coin, primaryExchange, (data) => {
      primaryData = data;
      updateSpread();
    });

    const closeSecondary = this.streamDepth(coin, secondaryExchange, (data) => {
      secondaryData = data;
      updateSpread();
    });

    const setAmount = (newAmount: number) => {
      currentAmount = newAmount;
      updateSpread(true);
    };

    const setOrderType = (newOrderType: string) => {
      currentOrderType = newOrderType;
      updateSpread(true);
    };

    this.monitors.set(botId, { stats, closePrimary, closeSecondary, setAmount, setOrderType });
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

  setAmount(botId: number, amount: number) {
    this.monitors.get(botId)?.setAmount(amount);
  }

  setOrderType(botId: number, orderType: string) {
    this.monitors.get(botId)?.setOrderType(orderType);
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
    setAmount: monitorManager.setAmount.bind(monitorManager),
    setOrderType: monitorManager.setOrderType.bind(monitorManager),
  };
}

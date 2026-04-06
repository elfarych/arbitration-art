import axios from 'axios';
import type { ExchangeTickerInfo, TickerData, AggTrade, KlineData, DepthData } from './binanceApi';

const mexcHttp = axios.create({ baseURL: '/mexc-api/api/v1/contract' });

export const mexcApi = {
  async getAllTickers(): Promise<Record<string, { bid: number; ask: number }>> {
    try {
      const { data } = await mexcHttp.get<{ success: boolean; data: Array<{ symbol: string; bid1: number; ask1: number }> }>('/ticker');
      const result: Record<string, { bid: number; ask: number }> = {};
      if (data.success && data.data) {
        for (const item of data.data) {
          if (item.symbol.endsWith('_USDT')) {
            const coin = item.symbol.replace('_USDT', '');
            result[coin] = {
              bid: item.bid1,
              ask: item.ask1
            };
          }
        }
      }
      return result;
    } catch (e) {
      console.error('MEXC Futures getAllTickers error:', e);
      return {};
    }
  },

  async symbolExists(coin: string): Promise<boolean> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    try {
      const { data } = await mexcHttp.get<{ success: boolean; data: unknown }>(`/detail?symbol=${symbol}`);
      return data.success && !!data.data;
    } catch {
      return false;
    }
  },

  async getPrice(coin: string): Promise<number | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    try {
      const { data } = await mexcHttp.get<{ success: boolean; data: { lastPrice: number } }>(`/ticker?symbol=${symbol}`);
      return data.success ? data.data.lastPrice : null;
    } catch {
      return null;
    }
  },

  async getLastTradePrice(coin: string): Promise<number | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    try {
      const { data } = await mexcHttp.get<{ success: boolean; data: { p: number }[] }>(`/deals/${symbol}?limit=1`);
      return data.success && data.data?.length > 0 ? data.data[0].p : null;
    } catch {
      return null;
    }
  },

  async getTickerInfo(coin: string): Promise<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    try {
      const [fundingReq, tickerReq] = await Promise.all([
        mexcHttp.get<{ success: boolean; data: { fundingRate: number; nextSettleTime: number } }>(`/funding_rate/${symbol}`).catch(() => ({ data: { success: false, data: null } })),
        mexcHttp.get<{ success: boolean; data: { ask1: number; bid1: number; volume24: number; amount24: number; lastPrice: number; fundingRate: number } }>(`/ticker?symbol=${symbol}`)
      ]);
      const funding = fundingReq.data;
      const ticker = tickerReq.data;

      const rate = funding.success && funding.data ? funding.data.fundingRate : ticker.data.fundingRate;
      const lastPrice = ticker.data.lastPrice;

      return {
        fundingRate: rate * 100,
        fundingRateUsdt: rate * lastPrice * ticker.data.volume24,
        nextFundingTimestamp: funding.success && funding.data ? funding.data.nextSettleTime : 0,
        ask: ticker.data.ask1,
        bid: ticker.data.bid1,
        size: ticker.data.volume24,
        sizeUsdt: ticker.data.amount24,
      };
    } catch {
      return null;
    }
  },

  streamTicker(coin: string, onMessage: (data: TickerData) => void, onError?: (err: Error) => void): () => void {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const url = 'wss://contract.mexc.com/edge';
    const ws = new WebSocket(url);
    let pingInterval: number;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol } }));
      pingInterval = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.channel === 'push.ticker' && msg.data) {
          onMessage({
            bid: msg.data.bid1,
            ask: msg.data.ask1,
            bidQty: msg.data.bidVol1 || 0,
            askQty: msg.data.askVol1 || 0,
            volume: msg.data.volume24 || 0,
          });
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('MEXC WS error'));
      ws.onclose = () => onError(new Error('MEXC WS closed unexpectedly'));
    }

    return () => {
      window.clearInterval(pingInterval);
      ws.close();
    };
  },

  streamDepth(coin: string, onMessage: (data: DepthData) => void, onError?: (err: Error) => void): () => void {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const url = 'wss://contract.mexc.com/edge';
    const ws = new WebSocket(url);
    let pingInterval: number;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'sub.depth', param: { symbol } }));
      pingInterval = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.channel === 'push.depth' && msg.data) {
          const d = msg.data;
          if (d.asks || d.bids) {
            onMessage({
              bids: (d.bids || []).map((item: number[]) => [item[0], item[1]]),
              asks: (d.asks || []).map((item: number[]) => [item[0], item[1]]),
            });
          }
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('MEXC WS Depth error'));
      ws.onclose = () => onError(new Error('MEXC WS Depth closed unexpectedly'));
    }

    return () => {
      window.clearInterval(pingInterval);
      ws.close();
    };
  },

  async getDeals(coin: string, limit = 1000): Promise<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const { data } = await mexcHttp.get<{ success: boolean; data: { p: number; t: number }[] }>(`/deals/${symbol}?limit=${limit}`);
    return data.success ? data.data.map(d => ({ price: d.p, timestamp: d.t })) : [];
  },

  async getKlines(coin: string, limit = 1000, endTime?: number): Promise<KlineData[]> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const end = endTime ? Math.floor(endTime / 1000) : Math.floor(Date.now() / 1000);
    const start = end - limit * 60;

    const { data } = await mexcHttp.get<{ success: boolean; data: { time: number[]; open: number[]; high: number[]; low: number[]; close: number[] } }>(`/kline/${symbol}?interval=Min1&start=${start}&end=${end}`);
    
    if (!data.success || !data.data?.time) return [];

    return data.data.time.map((t, i) => ({
      timestamp: t * 1000,
      open: data.data.open[i],
      high: data.data.high[i],
      low: data.data.low[i],
      close: data.data.close[i],
    }));
  }
};

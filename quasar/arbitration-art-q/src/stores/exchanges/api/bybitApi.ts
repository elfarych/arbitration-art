import axios from 'axios';
import type { ExchangeTickerInfo, TickerData, AggTrade, DepthData, KlineData } from './binanceApi';

const bybitHttp = axios.create({ baseURL: '/bybit-api/v5' });

export const bybitApi = {
  async getAllTickers(): Promise<Record<string, { bid: number; ask: number }>> {
    try {
      const { data } = await bybitHttp.get('/market/tickers?category=linear');
      const result: Record<string, { bid: number; ask: number }> = {};
      
      if (data && data.result && data.result.list) {
        for (const item of data.result.list) {
          if (item.symbol.endsWith('USDT')) {
            const coin = item.symbol.replace('USDT', '');
            result[coin] = {
              bid: parseFloat(item.bid1Price),
              ask: parseFloat(item.ask1Price)
            };
          }
        }
      }
      return result;
    } catch (e) {
      console.error('Bybit getAllTickers error:', e);
      return {};
    }
  },

  async symbolExists(coin: string): Promise<boolean> {
    try {
      const { data } = await bybitHttp.get(`/market/tickers?category=linear&symbol=${coin.toUpperCase()}USDT`);
      return data.result && data.result.list && data.result.list.length > 0;
    } catch {
      return false;
    }
  },

  async getPrice(coin: string): Promise<number | null> {
    try {
      const { data } = await bybitHttp.get(`/market/tickers?category=linear&symbol=${coin.toUpperCase()}USDT`);
      if (data.result && data.result.list && data.result.list.length > 0) {
        return parseFloat(data.result.list[0].lastPrice);
      }
      return null;
    } catch {
      return null;
    }
  },

  async getLastTradePrice(coin: string): Promise<number | null> {
    try {
      const { data } = await bybitHttp.get(`/market/recent-trade?category=linear&symbol=${coin.toUpperCase()}USDT&limit=1`);
      if (data.result && data.result.list && data.result.list.length > 0) {
        return parseFloat(data.result.list[0].price);
      }
      return null;
    } catch {
      return null;
    }
  },

  async getTickerInfo(coin: string): Promise<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}USDT`;
    try {
      const { data } = await bybitHttp.get(`/market/tickers?category=linear&symbol=${symbol}`);
      if (!data.result || !data.result.list || data.result.list.length === 0) return null;
      
      const ticker = data.result.list[0];

      return {
        fundingRate: parseFloat(ticker.fundingRate) * 100,
        fundingRateUsdt: 0, // Bybit doesn't easily expose this as Binance does, setting to 0 or could calc: fundingRate * lastPrice * volume
        nextFundingTimestamp: parseInt(ticker.nextFundingTime) || 0,
        ask: parseFloat(ticker.ask1Price),
        bid: parseFloat(ticker.bid1Price),
        size: parseFloat(ticker.volume24h),
        sizeUsdt: parseFloat(ticker.turnover24h),
      };
    } catch {
      return null;
    }
  },

  streamTicker(coin: string, onMessage: (data: TickerData) => void, onError?: (err: Error) => void): () => void {
    const symbol = `${coin.toUpperCase()}USDT`;
    const url = 'wss://stream.bybit.com/v5/public/linear';
    const ws = new WebSocket(url);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [`bookticker.${symbol}`]
      }));
    };

    ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        if (d.topic === `bookticker.${symbol}` && d.data) {
          const item = d.data;
          onMessage({
            bid: parseFloat(item.bp),
            ask: parseFloat(item.ap),
            bidQty: parseFloat(item.bq),
            askQty: parseFloat(item.aq),
            volume: 0,
          });
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('Bybit WS error'));
      ws.onclose = () => onError(new Error('Bybit WS closed unexpectedly'));
    }

    return () => ws.close();
  },

  streamDepth(coin: string, onMessage: (data: DepthData) => void, onError?: (err: Error) => void): () => void {
    const symbol = `${coin.toUpperCase()}USDT`;
    const url = 'wss://stream.bybit.com/v5/public/linear';
    const ws = new WebSocket(url);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        op: 'subscribe',
        args: [`orderbook.50.${symbol}`]
      }));
    };

    ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        if (d.topic === `orderbook.50.${symbol}` && d.data) {
          onMessage({
            bids: d.data.b ? d.data.b.map((item: string[]) => [parseFloat(item[0] as string), parseFloat(item[1] as string)]) : [],
            asks: d.data.a ? d.data.a.map((item: string[]) => [parseFloat(item[0] as string), parseFloat(item[1] as string)]) : [],
          });
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('Bybit WS Depth error'));
      ws.onclose = () => onError(new Error('Bybit WS Depth closed unexpectedly'));
    }

    return () => ws.close();
  },

  async getAggTrades(coin: string, limit = 1000, endTime?: number): Promise<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    // For Bybit, max limit is 1000 for recent-trade, doesn't easily paginate backwards with endTime. We'll do best effort.
    const url = `/market/recent-trade?category=linear&symbol=${symbol}&limit=${limit > 1000 ? 1000 : limit}`;

    const { data } = await bybitHttp.get(url);
    if (!data.result || !data.result.list) return [];
    
    return data.result.list.map((t: any) => ({
      price: parseFloat(t.price),
      timestamp: parseInt(t.time)
    }));
  },

  async getKlines(coin: string, limit = 1000, endTime?: number): Promise<KlineData[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `/market/kline?category=linear&symbol=${symbol}&interval=1&limit=${limit > 1000 ? 1000 : limit}`;
    if (endTime) url += `&end=${endTime}`;

    const { data } = await bybitHttp.get(url);
    if (!data.result || !data.result.list) return [];

    // Bybit list: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
    // The data is returned so new objects are at the front (descending timestamp). We might need to sort if the app expects ascending.
    const klines = data.result.list.map((k: string[]) => ({
      timestamp: parseInt(k[0] as string),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
    }));
    
    // Reverse it to be older first (ascending)
    return klines.reverse();
  }
};

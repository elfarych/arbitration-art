import axios from 'axios';
import type { ExchangeTickerInfo, TickerData, AggTrade, DepthData, KlineData } from './binanceApi';

const binanceSpotHttp = axios.create({ baseURL: '/binance-spot-api/api/v3' });

export const binanceSpotApi = {
  async getAllTickers(): Promise<Record<string, { bid: number; ask: number }>> {
    try {
      const { data } = await binanceSpotHttp.get<Array<{ symbol: string; bidPrice: string; askPrice: string }>>('/ticker/bookTicker');
      const result: Record<string, { bid: number; ask: number }> = {};
      for (const item of data) {
        if (item.symbol.endsWith('USDT')) {
          const coin = item.symbol.replace('USDT', '');
          result[coin] = {
            bid: parseFloat(item.bidPrice),
            ask: parseFloat(item.askPrice)
          };
        }
      }
      return result;
    } catch (e) {
      console.error('Binance Spot getAllTickers error:', e);
      return {};
    }
  },

  async symbolExists(coin: string): Promise<boolean> {
    try {
      await binanceSpotHttp.get(`/ticker/price?symbol=${coin.toUpperCase()}USDT`);
      return true;
    } catch {
      return false;
    }
  },

  async getPrice(coin: string): Promise<number | null> {
    try {
      const { data } = await binanceSpotHttp.get<{ price: string }>(`/ticker/price?symbol=${coin.toUpperCase()}USDT`);
      return parseFloat(data.price);
    } catch {
      return null;
    }
  },

  async getLastTradePrice(coin: string): Promise<number | null> {
    try {
      const { data } = await binanceSpotHttp.get<{ p: string }[]>(`/aggTrades?symbol=${coin.toUpperCase()}USDT&limit=1`);
      if (data && data.length > 0) {
        return parseFloat((data[0] as any).p);
      }
      return null;
    } catch {
      return null;
    }
  },

  async getTickerInfo(coin: string): Promise<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}USDT`;
    try {
      const [bookReq, tickerReq] = await Promise.all([
        binanceSpotHttp.get(`/ticker/bookTicker?symbol=${symbol}`),
        binanceSpotHttp.get(`/ticker/24hr?symbol=${symbol}`)
      ]);
      const book = bookReq.data;
      const ticker = tickerReq.data;

      const volume = parseFloat(ticker.volume);

      return {
        fundingRate: 0,
        fundingRateUsdt: 0,
        nextFundingTimestamp: 0,
        ask: parseFloat(book.askPrice),
        bid: parseFloat(book.bidPrice),
        size: volume,
        sizeUsdt: parseFloat(ticker.quoteVolume),
      };
    } catch {
      return null;
    }
  },

  streamTicker(coin: string, onMessage: (data: TickerData) => void, onError?: (err: Error) => void): () => void {
    const symbol = coin.toLowerCase() + 'usdt';
    const url = `wss://stream.binance.com:9443/ws/${symbol}@bookTicker`;
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        onMessage({
          bid: parseFloat(d.b),
          ask: parseFloat(d.a),
          bidQty: parseFloat(d.B),
          askQty: parseFloat(d.A),
          volume: 0,
        });
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('Binance Spot WS error'));
      ws.onclose = () => onError(new Error('Binance Spot WS closed unexpectedly'));
    }

    return () => ws.close();
  },

  streamDepth(coin: string, onMessage: (data: DepthData) => void, onError?: (err: Error) => void): () => void {
    const symbol = coin.toLowerCase() + 'usdt';
    const url = `wss://stream.binance.com:9443/ws/${symbol}@depth20@100ms`;
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        if (d.bids && d.asks) {
          onMessage({
            bids: d.bids.map((item: string[]) => [parseFloat(item[0] as string), parseFloat(item[1] as string)]),
            asks: d.asks.map((item: string[]) => [parseFloat(item[0] as string), parseFloat(item[1] as string)]),
          });
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('Binance Spot WS Depth error'));
      ws.onclose = () => onError(new Error('Binance Spot WS Depth closed unexpectedly'));
    }

    return () => ws.close();
  },

  async getAggTrades(coin: string, limit = 1000, endTime?: number): Promise<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `/aggTrades?symbol=${symbol}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const { data } = await binanceSpotHttp.get<{ p: string; q: string; T: number }[]>(url);
    return data.map(t => ({ price: parseFloat(t.p), timestamp: t.T }));
  },

  async getKlines(coin: string, limit = 1000, endTime?: number): Promise<KlineData[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const { data } = await binanceSpotHttp.get<(string | number)[][]>(url);
    return data.map(k => ({
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
    }));
  }
};

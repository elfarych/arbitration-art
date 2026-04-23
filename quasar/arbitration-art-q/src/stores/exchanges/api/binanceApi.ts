import axios from 'axios';

export interface ExchangeTickerInfo {
  fundingRate: number;
  fundingRateUsdt: number;
  nextFundingTimestamp: number;
  ask: number;
  bid: number;
  size: number;
  sizeUsdt: number;
}

export interface TickerData {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
}

export interface AggTrade {
  price: number;
  timestamp: number;
}

export interface DepthData {
  bids: [number, number][]; // price, quantity
  asks: [number, number][]; // price, quantity
}

export interface KlineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const binanceHttp = axios.create({ baseURL: '/binance-api/fapi/v1' });

export const binanceApi = {
  async getAllTickers(): Promise<Record<string, { bid: number; ask: number }>> {
    try {
      const { data } = await binanceHttp.get<Array<{ symbol: string; bidPrice: string; askPrice: string }>>('/ticker/bookTicker');
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
      console.error('Binance Futures getAllTickers error:', e);
      return {};
    }
  },

  async symbolExists(coin: string): Promise<boolean> {
    try {
      await binanceHttp.get(`/ticker/price?symbol=${coin.toUpperCase()}USDT`);
      return true;
    } catch {
      return false;
    }
  },

  async getPrice(coin: string): Promise<number | null> {
    try {
      const { data } = await binanceHttp.get<{ price: string }>(`/ticker/price?symbol=${coin.toUpperCase()}USDT`);
      return parseFloat(data.price);
    } catch {
      return null;
    }
  },

  async getLastTradePrice(coin: string): Promise<number | null> {
    try {
      const { data } = await binanceHttp.get<{ p: string }[]>(`/aggTrades?symbol=${coin.toUpperCase()}USDT&limit=1`);
      return data.length > 0 ? parseFloat(data[0].p) : null;
    } catch {
      return null;
    }
  },

  async getTickerInfo(coin: string): Promise<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}USDT`;
    try {
      const [premiumReq, bookReq, tickerReq] = await Promise.all([
        binanceHttp.get(`/premiumIndex?symbol=${symbol}`).catch(() => ({ data: { lastFundingRate: '0', nextFundingTime: 0 } })),
        binanceHttp.get(`/ticker/bookTicker?symbol=${symbol}`),
        binanceHttp.get(`/ticker/24hr?symbol=${symbol}`)
      ]);
      const premium = premiumReq.data;
      const book = bookReq.data;
      const ticker = tickerReq.data;

      const rate = parseFloat(premium.lastFundingRate);
      const lastPrice = parseFloat(ticker.lastPrice);
      const volume = parseFloat(ticker.volume);

      return {
        fundingRate: rate * 100,
        fundingRateUsdt: rate * lastPrice * volume,
        nextFundingTimestamp: premium.nextFundingTime,
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
    const url = `wss://fstream.binance.com/market/ws/${symbol}@bookTicker`;
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
      ws.onerror = () => onError(new Error('Binance WS error'));
      ws.onclose = () => onError(new Error('Binance WS closed unexpectedly'));
    }

    return () => ws.close();
  },

  streamDepth(coin: string, onMessage: (data: DepthData) => void, onError?: (err: Error) => void): () => void {
    const symbol = coin.toLowerCase() + 'usdt';
    const url = `wss://fstream.binance.com/market/ws/${symbol}@depth20@100ms`;
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      try {
        const d = JSON.parse(event.data);
        if (d.e === 'depthUpdate' || (d.b && d.a)) { // Format sanity check
          onMessage({
            bids: d.b.map((item: string[]) => [parseFloat(item[0]), parseFloat(item[1])]),
            asks: d.a.map((item: string[]) => [parseFloat(item[0]), parseFloat(item[1])]),
          });
        }
      } catch {}
    };

    if (onError) {
      ws.onerror = () => onError(new Error('Binance WS Depth error'));
      ws.onclose = () => onError(new Error('Binance WS Depth closed unexpectedly'));
    }

    return () => ws.close();
  },

  async getAggTrades(coin: string, limit = 1000, endTime?: number): Promise<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `/aggTrades?symbol=${symbol}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const { data } = await binanceHttp.get<{ p: string; q: string; T: number }[]>(url);
    return data.map(t => ({ price: parseFloat(t.p), timestamp: t.T }));
  },

  async getKlines(coin: string, limit = 1000, endTime?: number): Promise<KlineData[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const { data } = await binanceHttp.get<(string | number)[][]>(url);
    return data.map(k => ({
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
    }));
  }
};

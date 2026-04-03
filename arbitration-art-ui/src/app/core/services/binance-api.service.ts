import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, forkJoin, map, Observable, of } from 'rxjs';

import { ExchangeTickerInfo } from './exchange-info.service';

@Injectable({ providedIn: 'root' })
export class BinanceApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/binance-api/fapi/v1';

  /**
   * Check if a USDT perpetual symbol exists.
   */
  symbolExists(coin: string): Observable<boolean> {
    return this.http
      .get<{ symbol: string; price: string }>(
        `${this.baseUrl}/ticker/price?symbol=${coin.toUpperCase()}USDT`,
      )
      .pipe(
        map(() => true),
        catchError(() => of(false)),
      );
  }

  /**
   * Get current USDT price of a coin.
   */
  getPrice(coin: string): Observable<number | null> {
    return this.http
      .get<{ price: string }>(
        `${this.baseUrl}/ticker/price?symbol=${coin.toUpperCase()}USDT`,
      )
      .pipe(
        map((res) => parseFloat(res.price)),
        catchError(() => of(null)),
      );
  }

  /**
   * Get latest trade price via aggTrades.
   */
  getLastTradePrice(coin: string): Observable<number | null> {
    return this.http
      .get<{ p: string }[]>(
        `${this.baseUrl}/aggTrades?symbol=${coin.toUpperCase()}USDT&limit=1`,
      )
      .pipe(
        map((trades) => (trades.length > 0 ? parseFloat(trades[0].p) : null)),
        catchError(() => of(null)),
      );
  }

  /**
   * Get funding rate, ask, bid, size.
   */
  getTickerInfo(coin: string): Observable<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}USDT`;

    return forkJoin({
      premium: this.http.get<{
        lastFundingRate: string;
        nextFundingTime: number;
      }>(`${this.baseUrl}/premiumIndex?symbol=${symbol}`),
      book: this.http.get<{
        askPrice: string;
        bidPrice: string;
      }>(`${this.baseUrl}/ticker/bookTicker?symbol=${symbol}`),
      ticker: this.http.get<{
        quoteVolume: string;
        volume: string;
        lastPrice: string;
      }>(`${this.baseUrl}/ticker/24hr?symbol=${symbol}`),
    }).pipe(
      map(({ premium, book, ticker }) => {
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
      }),
      catchError(() => of(null)),
    );
  }

  /**
   * Real-time bid/ask stream via WebSocket (bookTicker).
   * Emits bid/ask on every order book update.
   */
  streamTicker(coin: string): Observable<TickerData> {
    const symbol = coin.toLowerCase() + 'usdt';
    const url = `wss://fstream.binance.com/ws/${symbol}@bookTicker`;

    return new Observable<TickerData>((subscriber) => {
      const ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          subscriber.next({
            bid: parseFloat(d.b),
            ask: parseFloat(d.a),
            bidQty: parseFloat(d.B),
            askQty: parseFloat(d.A),
            volume: 0,
          });
        } catch {
          // ignore
        }
      };

      ws.onerror = () => subscriber.error(new Error('Binance WS error'));
      ws.onclose = () =>
        subscriber.error(new Error('Binance WS closed unexpectedly'));

      return () => ws.close();
    });
  }

  /**
   * Fetch aggregated trades for spread history.
   * Returns up to 1000 trades, sorted newest-first.
   */
  getAggTrades(coin: string, limit = 1000, endTime?: number): Observable<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `${this.baseUrl}/aggTrades?symbol=${symbol}&limit=${limit}`;
    if (endTime) {
      url += `&endTime=${endTime}`;
    }

    return this.http.get<{ p: string; q: string; T: number }[]>(url).pipe(
      map((trades) =>
        trades.map((t) => ({
          price: parseFloat(t.p),
          timestamp: t.T,
        })),
      ),
    );
  }

  /**
   * Fetch 1-minute kline (candlestick) data.
   * Returns OHLC data for spread history.
   */
  getKlines(
    coin: string,
    limit = 1000,
    endTime?: number,
  ): Observable<KlineData[]> {
    const symbol = `${coin.toUpperCase()}USDT`;
    let url = `${this.baseUrl}/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
    if (endTime) {
      url += `&endTime=${endTime}`;
    }

    // Binance klines response: array of arrays
    // [openTime, open, high, low, close, volume, closeTime, ...]
    return this.http.get<(string | number)[][]>(url).pipe(
      map((klines) =>
        klines.map((k) => ({
          timestamp: k[0] as number, // openTime
          open: parseFloat(k[1] as string),
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
        })),
      ),
    );
  }
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

export interface KlineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}


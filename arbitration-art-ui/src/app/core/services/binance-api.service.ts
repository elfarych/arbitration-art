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
   * Real-time ticker stream via WebSocket.
   * Emits bid/ask/volume on every update.
   */
  streamTicker(coin: string): Observable<TickerData> {
    const symbol = coin.toLowerCase() + 'usdt';
    const url = `wss://fstream.binance.com/ws/${symbol}@ticker`;

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
            volume: parseFloat(d.v),
          });
        } catch {
          // ignore
        }
      };

      ws.onerror = () => subscriber.error(new Error('Binance WS error'));
      ws.onclose = () => subscriber.complete();

      return () => ws.close();
    });
  }
}

export interface TickerData {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
}

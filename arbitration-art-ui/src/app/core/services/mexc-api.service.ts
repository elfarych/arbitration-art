import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, forkJoin, map, Observable, of } from 'rxjs';

import { ExchangeTickerInfo } from './exchange-info.service';
import { AggTrade, KlineData, TickerData } from './binance-api.service';

@Injectable({ providedIn: 'root' })
export class MexcApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/mexc-api/api/v1/contract';

  symbolExists(coin: string): Observable<boolean> {
    const symbol = `${coin.toUpperCase()}_USDT`;

    return this.http
      .get<{ success: boolean; data: unknown }>(
        `${this.baseUrl}/detail?symbol=${symbol}`,
      )
      .pipe(
        map((res) => res.success && !!res.data),
        catchError(() => of(false)),
      );
  }

  getPrice(coin: string): Observable<number | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;

    return this.http
      .get<{ success: boolean; data: { lastPrice: number } }>(
        `${this.baseUrl}/ticker?symbol=${symbol}`,
      )
      .pipe(
        map((res) => (res.success ? res.data.lastPrice : null)),
        catchError(() => of(null)),
      );
  }

  getLastTradePrice(coin: string): Observable<number | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;

    return this.http
      .get<{ success: boolean; data: { p: number }[] }>(
        `${this.baseUrl}/deals/${symbol}?limit=1`,
      )
      .pipe(
        map((res) =>
          res.success && res.data?.length > 0 ? res.data[0].p : null,
        ),
        catchError(() => of(null)),
      );
  }

  getTickerInfo(coin: string): Observable<ExchangeTickerInfo | null> {
    const symbol = `${coin.toUpperCase()}_USDT`;

    return forkJoin({
      funding: this.http.get<{
        success: boolean;
        data: { fundingRate: number; nextSettleTime: number };
      }>(`${this.baseUrl}/funding_rate/${symbol}`),
      ticker: this.http.get<{
        success: boolean;
        data: {
          ask1: number;
          bid1: number;
          volume24: number;
          amount24: number;
          lastPrice: number;
          fundingRate: number;
        };
      }>(`${this.baseUrl}/ticker?symbol=${symbol}`),
    }).pipe(
      map(({ funding, ticker }) => {
        const rate = funding.success
          ? funding.data.fundingRate
          : ticker.data.fundingRate;
        const lastPrice = ticker.data.lastPrice;

        return {
          fundingRate: rate * 100,
          fundingRateUsdt: rate * lastPrice * ticker.data.volume24,
          nextFundingTimestamp: funding.success
            ? funding.data.nextSettleTime
            : 0,
          ask: ticker.data.ask1,
          bid: ticker.data.bid1,
          size: ticker.data.volume24,
          sizeUsdt: ticker.data.amount24,
        };
      }),
      catchError(() => of(null)),
    );
  }

  /**
   * Real-time ticker stream via WebSocket.
   * Emits bid/ask on every update.
   */
  streamTicker(coin: string): Observable<TickerData> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const url = 'wss://contract.mexc.com/edge';

    return new Observable<TickerData>((subscriber) => {
      const ws = new WebSocket(url);
      let pingInterval: ReturnType<typeof setInterval>;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            method: 'sub.ticker',
            param: { symbol },
          }),
        );

        // Send ping every 30s to keep the connection alive
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 30_000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'push.ticker' && msg.data) {
            subscriber.next({
              bid: msg.data.bid1,
              ask: msg.data.ask1,
              bidQty: msg.data.bidVol1 || 0,
              askQty: msg.data.askVol1 || 0,
              volume: msg.data.volume24 || 0,
            });
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => subscriber.error(new Error('MEXC WS error'));
      ws.onclose = () =>
        subscriber.error(new Error('MEXC WS closed unexpectedly'));

      return () => {
        clearInterval(pingInterval);
        ws.close();
      };
    });
  }

  /**
   * Fetch recent contract deals for spread history.
   * Returns up to `limit` trades, sorted newest-first.
   */
  getDeals(coin: string, limit = 1000): Observable<AggTrade[]> {
    const symbol = `${coin.toUpperCase()}_USDT`;

    return this.http
      .get<{ success: boolean; data: { p: number; t: number }[] }>(
        `${this.baseUrl}/deals/${symbol}?limit=${limit}`,
      )
      .pipe(
        map((res) =>
          res.success
            ? res.data.map((d) => ({ price: d.p, timestamp: d.t }))
            : [],
        ),
      );
  }

  /**
   * Fetch kline (candlestick) data for a time range.
   * Returns OHLC data for spread history.
   */
  getKlines(
    coin: string,
    limit = 1000,
    endTime?: number,
  ): Observable<KlineData[]> {
    const symbol = `${coin.toUpperCase()}_USDT`;
    const end = endTime
      ? Math.floor(endTime / 1000)
      : Math.floor(Date.now() / 1000);
    // Go back `limit` minutes from endTime
    const start = end - limit * 60;

    return this.http
      .get<{
        success: boolean;
        data: {
          time: number[];
          open: number[];
          high: number[];
          low: number[];
          close: number[];
        };
      }>(`${this.baseUrl}/kline/${symbol}?interval=Min1&start=${start}&end=${end}`)
      .pipe(
        map((res) => {
          if (!res.success || !res.data?.time) return [];

          return res.data.time.map((t, i) => ({
            timestamp: t * 1000,
            open: res.data.open[i],
            high: res.data.high[i],
            low: res.data.low[i],
            close: res.data.close[i],
          }));
        }),
      );
  }
}

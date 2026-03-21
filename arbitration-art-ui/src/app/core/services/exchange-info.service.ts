import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable, catchError, of } from 'rxjs';

import { BinanceApiService } from './binance-api.service';
import { MexcApiService } from './mexc-api.service';

export interface ExchangeTickerInfo {
  fundingRate: number;
  fundingRateUsdt: number;
  nextFundingTimestamp: number;
  ask: number;
  bid: number;
  size: number;
  sizeUsdt: number;
}

export interface BotExchangeInfo {
  primary: ExchangeTickerInfo | null;
  secondary: ExchangeTickerInfo | null;
  loading: boolean;
}

@Injectable({ providedIn: 'root' })
export class ExchangeInfoService {
  private readonly binance = inject(BinanceApiService);
  private readonly mexc = inject(MexcApiService);

  getInfo(
    coin: string,
    primaryExchange: string,
    secondaryExchange: string,
  ): Observable<BotExchangeInfo> {
    return forkJoin({
      primary: this.getExchangeInfo(coin, primaryExchange),
      secondary: this.getExchangeInfo(coin, secondaryExchange),
    }).pipe(
      map(({ primary, secondary }) => ({
        primary,
        secondary,
        loading: false,
      })),
    );
  }

  private getExchangeInfo(
    coin: string,
    exchange: string,
  ): Observable<ExchangeTickerInfo | null> {
    switch (exchange) {
      case 'binance_futures':
        return this.binance.getTickerInfo(coin);
      case 'mexc_futures':
        return this.mexc.getTickerInfo(coin);
      default:
        return of(null);
    }
  }
}

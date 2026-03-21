import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable, of } from 'rxjs';

import { BinanceApiService } from './binance-api.service';
import { MexcApiService } from './mexc-api.service';

export interface CoinValidationResult {
  exchange: string;
  symbol: string;
  exists: boolean;
}

@Injectable({ providedIn: 'root' })
export class ExchangeValidationService {
  private readonly binance = inject(BinanceApiService);
  private readonly mexc = inject(MexcApiService);

  /**
   * Check if a coin exists as a USDT perpetual on the given exchanges.
   */
  validateCoin(
    coin: string,
    exchanges: string[],
  ): Observable<CoinValidationResult[]> {
    const checks = exchanges.map((exchange) =>
      this.checkExchange(coin, exchange),
    );
    return forkJoin(checks);
  }

  /**
   * Get current USDT price from a given exchange.
   */
  getPrice(coin: string, exchange: string): Observable<number | null> {
    switch (exchange) {
      case 'binance_futures':
        return this.binance.getPrice(coin);
      case 'mexc_futures':
        return this.mexc.getPrice(coin);
      default:
        return of(null);
    }
  }

  private checkExchange(
    coin: string,
    exchange: string,
  ): Observable<CoinValidationResult> {
    const upperCoin = coin.toUpperCase();

    switch (exchange) {
      case 'binance_futures':
        return this.binance.symbolExists(upperCoin).pipe(
          map((exists) => ({
            exchange,
            symbol: `${upperCoin}USDT`,
            exists,
          })),
        );
      case 'mexc_futures':
        return this.mexc.symbolExists(upperCoin).pipe(
          map((exists) => ({
            exchange,
            symbol: `${upperCoin}_USDT`,
            exists,
          })),
        );
      default:
        return of({
          exchange,
          symbol: `${upperCoin}USDT`,
          exists: false,
        });
    }
  }
}

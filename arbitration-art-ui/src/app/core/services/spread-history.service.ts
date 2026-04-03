import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable } from 'rxjs';

import { KlineData, BinanceApiService } from './binance-api.service';
import { MexcApiService } from './mexc-api.service';

export interface SpreadHistoryPoint {
  timestamp: number;
  /** Open spread (close-based): sell primary, buy secondary */
  openSpread: number;
  /** Close spread (close-based): sell secondary, buy primary */
  closeSpread: number;
}

@Injectable({ providedIn: 'root' })
export class SpreadHistoryService {
  private readonly binance = inject(BinanceApiService);
  private readonly mexc = inject(MexcApiService);

  /**
   * Load 1-minute klines from both exchanges and calculate spread history.
   */
  loadHistory(
    coin: string,
    primaryExchange: string,
    secondaryExchange: string,
    limit = 1000,
  ): Observable<SpreadHistoryPoint[]> {
    const primary$ = this.fetchKlines(coin, primaryExchange, limit);
    const secondary$ = this.fetchKlines(coin, secondaryExchange, limit);

    return forkJoin([primary$, secondary$]).pipe(
      map(([primary, secondary]) =>
        this.calculateSpread(primary, secondary),
      ),
    );
  }

  private fetchKlines(
    coin: string,
    exchange: string,
    limit: number,
  ): Observable<KlineData[]> {
    switch (exchange) {
      case 'binance_futures':
        return this.binance.getKlines(coin, limit);
      case 'mexc_futures':
        return this.mexc.getKlines(coin, limit);
      default:
        throw new Error(`Unsupported exchange: ${exchange}`);
    }
  }

  private calculateSpread(
    primary: KlineData[],
    secondary: KlineData[],
  ): SpreadHistoryPoint[] {
    // Index secondary by minute
    const secondaryMap = new Map<number, KlineData>();
    for (const k of secondary) {
      const minute = Math.floor(k.timestamp / 60_000) * 60_000;
      secondaryMap.set(minute, k);
    }

    const points: SpreadHistoryPoint[] = [];

    for (const p of primary) {
      const minute = Math.floor(p.timestamp / 60_000) * 60_000;
      const s = secondaryMap.get(minute);
      if (!s) continue;

      // Open: sell primary, buy secondary (using close prices)
      const openSpread =
        ((p.close - s.close) / s.close) * 100;

      // Close: sell secondary, buy primary
      const closeSpread =
        ((s.close - p.close) / p.close) * 100;

      points.push({
        timestamp: minute,
        openSpread: Math.round(openSpread * 1000) / 1000,
        closeSpread: Math.round(closeSpread * 1000) / 1000,
      });
    }

    return points.sort((a, b) => a.timestamp - b.timestamp);
  }
}

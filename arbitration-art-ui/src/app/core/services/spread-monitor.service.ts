import { inject, Injectable } from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  Subscription,
  throttleTime,
  retry,
} from 'rxjs';

import { BinanceApiService, TickerData } from './binance-api.service';
import { MexcApiService } from './mexc-api.service';

export interface SpreadSnapshot {
  timestamp: number;
  openSpread: number;
  closeSpread: number;
}

export interface SpreadStats {
  current: SpreadSnapshot | null;
  minOpen: number;
  maxOpen: number;
  minClose: number;
  maxClose: number;
  history: SpreadSnapshot[];
  loading: boolean;
  // Live bid/ask data
  primaryBid: number;
  primaryAsk: number;
  secondaryBid: number;
  secondaryAsk: number;
  primaryVolume: number;
  secondaryVolume: number;
}

const INITIAL_STATS: SpreadStats = {
  current: null,
  minOpen: Infinity,
  maxOpen: -Infinity,
  minClose: Infinity,
  maxClose: -Infinity,
  history: [],
  loading: true,
  primaryBid: 0,
  primaryAsk: 0,
  secondaryBid: 0,
  secondaryAsk: 0,
  primaryVolume: 0,
  secondaryVolume: 0,
};

const MAX_HISTORY = 200;

@Injectable({ providedIn: 'root' })
export class SpreadMonitorService {
  private readonly binance = inject(BinanceApiService);
  private readonly mexc = inject(MexcApiService);

  private monitors = new Map<
    number,
    { subject: BehaviorSubject<SpreadStats>; sub: Subscription }
  >();

  start(
    botId: number,
    coin: string,
    primaryExchange: string,
    secondaryExchange: string,
  ): BehaviorSubject<SpreadStats> {
    const existing = this.monitors.get(botId);
    if (existing) {
      return existing.subject;
    }

    const subject = new BehaviorSubject<SpreadStats>({ ...INITIAL_STATS });

    const primary$ = this.streamTicker(coin, primaryExchange).pipe(
      retry({ delay: 3000 }),
    );
    const secondary$ = this.streamTicker(coin, secondaryExchange).pipe(
      retry({ delay: 3000 }),
    );

    const sub = combineLatest([primary$, secondary$])
      .pipe(throttleTime(500))
      .subscribe(([primary, secondary]) => {
        if (!primary.bid || !secondary.bid) return;

        // Spread based on bid/ask:
        // Open: sell on primary (bid) and buy on secondary (ask)
        const openSpread =
          ((primary.bid - secondary.ask) / secondary.ask) * 100;
        // Close: sell on secondary (bid) and buy on primary (ask)
        const closeSpread =
          ((secondary.bid - primary.ask) / primary.ask) * 100;

        const snapshot: SpreadSnapshot = {
          timestamp: Date.now(),
          openSpread: Math.round(openSpread * 1000) / 1000,
          closeSpread: Math.round(closeSpread * 1000) / 1000,
        };

        const prev = subject.value;
        const history = [...prev.history, snapshot].slice(-MAX_HISTORY);

        subject.next({
          current: snapshot,
          minOpen: Math.min(
            prev.minOpen === Infinity ? snapshot.openSpread : prev.minOpen,
            snapshot.openSpread,
          ),
          maxOpen: Math.max(
            prev.maxOpen === -Infinity ? snapshot.openSpread : prev.maxOpen,
            snapshot.openSpread,
          ),
          minClose: Math.min(
            prev.minClose === Infinity ? snapshot.closeSpread : prev.minClose,
            snapshot.closeSpread,
          ),
          maxClose: Math.max(
            prev.maxClose === -Infinity ? snapshot.closeSpread : prev.maxClose,
            snapshot.closeSpread,
          ),
          history,
          loading: false,
          primaryBid: primary.bid,
          primaryAsk: primary.ask,
          secondaryBid: secondary.bid,
          secondaryAsk: secondary.ask,
          primaryVolume: primary.volume,
          secondaryVolume: secondary.volume,
        });
      });

    this.monitors.set(botId, { subject, sub });
    return subject;
  }

  stop(botId: number): void {
    const monitor = this.monitors.get(botId);
    if (monitor) {
      monitor.sub.unsubscribe();
      monitor.subject.complete();
      this.monitors.delete(botId);
    }
  }

  stopAll(): void {
    for (const [id] of this.monitors) {
      this.stop(id);
    }
  }

  private streamTicker(coin: string, exchange: string) {
    switch (exchange) {
      case 'binance_futures':
        return this.binance.streamTicker(coin);
      case 'mexc_futures':
        return this.mexc.streamTicker(coin);
      default:
        throw new Error(`Unsupported exchange: ${exchange}`);
    }
  }
}

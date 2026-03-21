import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map, Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface BotConfig {
  id: number;
  primary_exchange: string;
  secondary_exchange: string;
  entry_spread: number;
  exit_spread: number;
  coin: string;
  coin_amount: number;
  order_type: 'buy' | 'sell' | 'auto';
  max_trades: number;
  open_ticks: number;
  close_ticks: number;
  primary_leverage: number;
  secondary_leverage: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type BotConfigPayload = Omit<BotConfig, 'id' | 'created_at' | 'updated_at'>;

@Injectable({ providedIn: 'root' })
export class BotConfigService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/bots`;

  list(): Observable<BotConfig[]> {
    return this.http
      .get<{ results: BotConfig[] }>(`${this.baseUrl}/`)
      .pipe(map((res) => res.results));
  }

  get(id: number): Observable<BotConfig> {
    return this.http.get<BotConfig>(`${this.baseUrl}/${id}/`);
  }

  create(data: BotConfigPayload): Observable<BotConfig> {
    return this.http.post<BotConfig>(`${this.baseUrl}/`, data);
  }

  update(id: number, data: Partial<BotConfigPayload>): Observable<BotConfig> {
    return this.http.patch<BotConfig>(`${this.baseUrl}/${id}/`, data);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/`);
  }
}

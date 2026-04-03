import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { AsyncPipe, DecimalPipe } from '@angular/common';
import { BehaviorSubject, interval, Subscription } from 'rxjs';

import { BotConfig, BotConfigService } from '../../core/services/bot-config.service';
import { SpreadMonitorService, SpreadStats } from '../../core/services/spread-monitor.service';
import { BotExchangeInfo, ExchangeInfoService } from '../../core/services/exchange-info.service';
import { BotFormComponent } from './bot-form.component';
import { SpreadChartComponent } from '../../shared/components/spread-chart.component';
import { SpreadHistoryDialogComponent } from './spread-history-dialog.component';

@Component({
  selector: 'app-bot-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AsyncPipe, DecimalPipe, BotFormComponent, SpreadChartComponent, SpreadHistoryDialogComponent],
  templateUrl: './bot-list.component.html',
  styleUrl: './bot-list.component.scss',
})
export class BotListComponent implements OnInit, OnDestroy {
  private readonly botService = inject(BotConfigService);
  private readonly spreadMonitor = inject(SpreadMonitorService);
  private readonly exchangeInfo = inject(ExchangeInfoService);

  readonly bots = signal<BotConfig[]>([]);
  readonly loading = signal(true);

  readonly exchangeLabels: Record<string, string> = {
    binance_futures: 'Binance Futures',
    mexc_futures: 'Mexc Futures',
  };

  // Dialog state
  readonly dialogOpen = signal(false);
  readonly editingBot = signal<BotConfig | null>(null);
  readonly historyBot = signal<BotConfig | null>(null);

  // Spread monitors per bot
  spreadSubjects = new Map<number, BehaviorSubject<SpreadStats>>();

  // Exchange info per bot
  exchangeInfoMap = signal<Map<number, BotExchangeInfo>>(new Map());

  // Tick signal for countdown
  readonly tick = signal(Date.now());
  private tickSub?: Subscription;

  ngOnInit(): void {
    this.loadBots();
    this.tickSub = interval(1000).subscribe(() => this.tick.set(Date.now()));
  }

  ngOnDestroy(): void {
    this.spreadMonitor.stopAll();
    this.tickSub?.unsubscribe();
  }

  openCreateDialog(): void {
    this.editingBot.set(null);
    this.dialogOpen.set(true);
  }

  openEditDialog(bot: BotConfig): void {
    this.editingBot.set(bot);
    this.dialogOpen.set(true);
  }

  onDialogClosed(result: BotConfig | null): void {
    this.dialogOpen.set(false);
    this.editingBot.set(null);

    if (result) {
      this.loadBots();
    }
  }

  openHistory(bot: BotConfig): void {
    this.historyBot.set(bot);
  }

  closeHistory(): void {
    this.historyBot.set(null);
  }

  deleteBot(id: number): void {
    if (!confirm('Удалить карточку бота?')) {
      return;
    }

    this.spreadMonitor.stop(id);
    this.spreadSubjects.delete(id);

    this.botService.delete(id).subscribe({
      next: () => this.loadBots(),
    });
  }

  toggleBot(bot: BotConfig): void {
    const newState = !bot.is_active;
    this.bots.update((list) =>
      list.map((b) => (b.id === bot.id ? { ...b, is_active: newState } : b)),
    );

    this.botService.update(bot.id, { is_active: newState }).subscribe({
      error: () => {
        this.bots.update((list) =>
          list.map((b) => (b.id === bot.id ? { ...b, is_active: !newState } : b)),
        );
      },
    });
  }

  getSpread(botId: number): BehaviorSubject<SpreadStats> | undefined {
    return this.spreadSubjects.get(botId);
  }

  getExchangeInfo(botId: number): BotExchangeInfo | undefined {
    return this.exchangeInfoMap().get(botId);
  }

  formatCountdown(timestamp: number): string {
    // Read tick to trigger re-evaluation
    this.tick();
    const diff = timestamp - Date.now();
    if (diff <= 0) return '00:00:00';

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  private loadBots(): void {
    this.loading.set(true);
    this.botService.list().subscribe({
      next: (bots) => {
        this.bots.set(bots);
        this.loading.set(false);
        this.startMonitors(bots);
        this.fetchExchangeInfo(bots);
      },
      error: () => this.loading.set(false),
    });
  }

  private startMonitors(bots: BotConfig[]): void {
    for (const [id] of this.spreadSubjects) {
      if (!bots.find((b) => b.id === id)) {
        this.spreadMonitor.stop(id);
        this.spreadSubjects.delete(id);
      }
    }

    for (const bot of bots) {
      if (!this.spreadSubjects.has(bot.id)) {
        const subject = this.spreadMonitor.start(
          bot.id,
          bot.coin,
          bot.primary_exchange,
          bot.secondary_exchange,
        );
        this.spreadSubjects.set(bot.id, subject);
      }
    }
  }

  private fetchExchangeInfo(bots: BotConfig[]): void {
    for (const bot of bots) {
      this.exchangeInfo
        .getInfo(bot.coin, bot.primary_exchange, bot.secondary_exchange)
        .subscribe((info) => {
          this.exchangeInfoMap.update((m) => {
            const next = new Map(m);
            next.set(bot.id, info);
            return next;
          });
        });
    }
  }
}

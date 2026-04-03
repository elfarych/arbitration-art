import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  OnDestroy,
  inject,
  input,
  output,
  signal,
  viewChild,
  AfterViewInit,
} from '@angular/core';
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

import { DecimalPipe } from '@angular/common';

import { BotConfig } from '../../core/services/bot-config.service';
import {
  SpreadHistoryService,
  SpreadHistoryPoint,
} from '../../core/services/spread-history.service';

const EXCHANGE_LABELS: Record<string, string> = {
  binance_futures: 'Binance',
  mexc_futures: 'MEXC',
};

@Component({
  selector: 'app-spread-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  templateUrl: './spread-history-dialog.component.html',
  styleUrl: './spread-history-dialog.component.scss',
})
export class SpreadHistoryDialogComponent implements AfterViewInit, OnDestroy {
  private readonly spreadHistory = inject(SpreadHistoryService);

  readonly bot = input.required<BotConfig>();
  readonly closed = output<void>();

  readonly chartContainer =
    viewChild.required<ElementRef<HTMLDivElement>>('chartContainer');

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly pointCount = signal(0);

  /** Labels for display in the template */
  readonly primaryLabel = computed(
    () => EXCHANGE_LABELS[this.bot().primary_exchange] || this.bot().primary_exchange,
  );
  readonly secondaryLabel = computed(
    () => EXCHANGE_LABELS[this.bot().secondary_exchange] || this.bot().secondary_exchange,
  );

  private chart: IChartApi | null = null;
  private openSpreadSeries: ISeriesApi<'Line'> | null = null;
  private closeSpreadSeries: ISeriesApi<'Line'> | null = null;

  ngAfterViewInit(): void {
    this.initChart();
    this.loadData();
  }

  ngOnDestroy(): void {
    this.chart?.remove();
  }

  close(): void {
    this.closed.emit();
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('dialog-backdrop')) {
      this.close();
    }
  }

  onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close();
    }
  }

  private initChart(): void {
    const container = this.chartContainer().nativeElement;

    this.chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255, 255, 255, 0.5)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255, 255, 255, 0.15)' },
        horzLine: { color: 'rgba(255, 255, 255, 0.15)' },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
      },
      autoSize: true,
    });

    const primaryName = this.primaryLabel();
    const secondaryName = this.secondaryLabel();

    // Open: sell on primary, buy on secondary
    this.openSpreadSeries = this.chart.addSeries(LineSeries, {
      color: '#4caf50',
      lineWidth: 2,
      title: `${primaryName} → ${secondaryName}`,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    });

    // Close: sell on secondary, buy on primary
    this.closeSpreadSeries = this.chart.addSeries(LineSeries, {
      color: '#ef5350',
      lineWidth: 2,
      title: `${secondaryName} → ${primaryName}`,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    });
  }

  private loadData(): void {
    this.loading.set(true);
    this.error.set(null);
    const bot = this.bot();

    this.spreadHistory
      .loadHistory(bot.coin, bot.primary_exchange, bot.secondary_exchange)
      .subscribe({
        next: (points) => {
          this.pointCount.set(points.length);
          this.updateChart(points);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Не удалось загрузить историю спреда');
          this.loading.set(false);
        },
      });
  }

  private updateChart(points: SpreadHistoryPoint[]): void {
    if (!this.openSpreadSeries || !this.closeSpreadSeries) return;

    const toSec = (ms: number) => Math.floor(ms / 1000) as Time;

    this.openSpreadSeries.setData(
      points.map((p) => ({ time: toSec(p.timestamp), value: p.openSpread })),
    );
    this.closeSpreadSeries.setData(
      points.map((p) => ({ time: toSec(p.timestamp), value: p.closeSpread })),
    );

    this.chart?.timeScale().fitContent();
  }
}

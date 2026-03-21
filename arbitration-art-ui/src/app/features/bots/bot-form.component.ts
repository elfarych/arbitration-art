import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';

import { BotConfig, BotConfigService } from '../../core/services/bot-config.service';
import {
  CoinValidationResult,
  ExchangeValidationService,
} from '../../core/services/exchange-validation.service';

@Component({
  selector: 'app-bot-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ReactiveFormsModule],
  templateUrl: './bot-form.component.html',
  styleUrl: './bot-form.component.scss',
})
export class BotFormComponent implements OnInit {
  private readonly botService = inject(BotConfigService);
  private readonly exchangeValidation = inject(ExchangeValidationService);
  private readonly destroyRef = inject(DestroyRef);

  /** Pass existing bot to enter edit mode */
  readonly bot = input<BotConfig | null>(null);

  /** Emitted when the dialog should close (with optional saved result) */
  readonly closed = output<BotConfig | null>();

  readonly saving = signal(false);
  readonly errorMessage = signal('');

  readonly editMode = computed(() => !!this.bot());

  readonly exchanges = [
    { value: 'binance_futures', label: 'Binance Futures' },
    { value: 'mexc_futures', label: 'Mexc Futures' },
  ];

  readonly selectedPrimary = signal('');
  readonly secondaryExchanges = computed(() =>
    this.exchanges.filter((ex) => ex.value !== this.selectedPrimary()),
  );

  // Coin validation
  readonly validating = signal(false);
  readonly validationResults = signal<CoinValidationResult[]>([]);
  readonly coinValidated = signal(false);
  readonly allValid = computed(() => {
    const results = this.validationResults();
    return results.length > 0 && results.every((r) => r.exists);
  });

  // USDT estimation
  readonly coinPrice = signal<number | null>(null);
  readonly coinAmount = signal(0);
  readonly estimatedUsdt = computed(() => {
    const price = this.coinPrice();
    const amount = this.coinAmount();
    return price != null && amount > 0 ? price * amount : null;
  });

  readonly form = new FormGroup({
    primary_exchange: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    secondary_exchange: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    entry_spread: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(0)],
    }),
    exit_spread: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(0)],
    }),
    coin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    coin_amount: new FormControl(0, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(0)],
    }),
    order_type: new FormControl<'buy' | 'sell' | 'auto'>('auto', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    max_trades: new FormControl(10, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    open_ticks: new FormControl(1, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    close_ticks: new FormControl(1, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    primary_leverage: new FormControl(1, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    secondary_leverage: new FormControl(1, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1)],
    }),
    is_active: new FormControl(false, { nonNullable: true }),
  });

  ngOnInit(): void {
    const bot = this.bot();
    if (bot) {
      this.form.patchValue(bot);
      this.selectedPrimary.set(bot.primary_exchange);
      this.coinAmount.set(bot.coin_amount);
    }
  }

  onPrimaryChange(): void {
    const primary = this.form.controls.primary_exchange.value;
    this.selectedPrimary.set(primary);

    if (this.form.controls.secondary_exchange.value === primary) {
      this.form.controls.secondary_exchange.reset('');
    }

    this.resetValidation();
    this.coinPrice.set(null);
  }

  onCoinChange(): void {
    this.resetValidation();
    this.coinPrice.set(null);
  }

  onCoinAmountChange(): void {
    this.coinAmount.set(this.form.controls.coin_amount.value);
    this.fetchPrice();
  }

  validateCoin(): void {
    const coin = this.form.controls.coin.value.trim();
    const primary = this.form.controls.primary_exchange.value;
    const secondary = this.form.controls.secondary_exchange.value;

    if (!coin || !primary || !secondary) {
      return;
    }

    this.validating.set(true);
    this.validationResults.set([]);
    this.coinValidated.set(false);

    this.exchangeValidation
      .validateCoin(coin, [primary, secondary])
      .subscribe((results) => {
        this.validationResults.set(results);
        this.coinValidated.set(true);
        this.validating.set(false);
      });
  }

  onSubmit(): void {
    if (this.form.invalid) {
      return;
    }

    this.saving.set(true);
    this.errorMessage.set('');

    const data = this.form.getRawValue();
    const bot = this.bot();

    const request$ = bot
      ? this.botService.update(bot.id, data)
      : this.botService.create(data);

    request$.subscribe({
      next: (result) => this.closed.emit(result),
      error: () => {
        this.saving.set(false);
        this.errorMessage.set('Ошибка сохранения. Проверьте данные.');
      },
    });
  }

  close(): void {
    this.closed.emit(null);
  }

  getExchangeLabel(value: string): string {
    return this.exchanges.find((ex) => ex.value === value)?.label ?? value;
  }

  private priceTimer: ReturnType<typeof setTimeout> | null = null;

  private fetchPrice(): void {
    const coin = this.form.controls.coin.value.trim();
    const exchange = this.form.controls.primary_exchange.value;

    if (!coin || !exchange) {
      this.coinPrice.set(null);
      return;
    }

    if (this.priceTimer) {
      clearTimeout(this.priceTimer);
    }

    this.priceTimer = setTimeout(() => {
      this.exchangeValidation
        .getPrice(coin, exchange)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((price) => this.coinPrice.set(price));
    }, 1000);
  }

  private resetValidation(): void {
    this.validationResults.set([]);
    this.coinValidated.set(false);
  }
}

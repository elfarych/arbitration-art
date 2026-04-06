from django.conf import settings
from django.db import models


class BotConfig(models.Model):
    """Arbitrage bot configuration card."""

    class Exchange(models.TextChoices):
        BINANCE_FUTURES = "binance_futures", "Binance Futures"
        BINANCE_SPOT = "binance_spot", "Binance Spot"
        BYBIT_FUTURES = "bybit_futures", "Bybit Futures"
        MEXC_FUTURES = "mexc_futures", "Mexc Futures"

    class OrderType(models.TextChoices):
        BUY = "buy", "Покупка"
        SELL = "sell", "Продажа"
        AUTO = "auto", "Авто"

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="bot_configs",
        verbose_name="owner",
    )
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=50,
        choices=Exchange.choices,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=Exchange.choices,
    )
    entry_spread = models.DecimalField(
        "entry spread",
        max_digits=10,
        decimal_places=4,
    )
    exit_spread = models.DecimalField(
        "exit spread",
        max_digits=10,
        decimal_places=4,
    )
    coin = models.CharField("coin", max_length=20)
    coin_amount = models.DecimalField(
        "coin amount",
        max_digits=18,
        decimal_places=8,
    )
    order_type = models.CharField(
        "order type",
        max_length=4,
        choices=OrderType.choices,
        default=OrderType.AUTO,
    )
    max_trades = models.PositiveIntegerField("max trades", default=10)
    open_ticks = models.PositiveIntegerField("open ticks", default=1)
    close_ticks = models.PositiveIntegerField("close ticks", default=1)
    primary_leverage = models.PositiveIntegerField("primary leverage", default=1)
    secondary_leverage = models.PositiveIntegerField("secondary leverage", default=1)
    is_active = models.BooleanField("active", default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "bot configuration"
        verbose_name_plural = "bot configurations"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.coin} | {self.primary_exchange} → {self.secondary_exchange}"


class EmulationTrade(models.Model):
    """Stores the execution cycle of an emulated arbitrage trade."""

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        CLOSED = "closed", "Closed"

    bot = models.ForeignKey(
        BotConfig,
        on_delete=models.SET_NULL,
        related_name="emulation_trades",
        verbose_name="bot configuration",
        null=True,
        blank=True,
    )
    coin = models.CharField("coin", max_length=50, null=True, blank=True)
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=50,
        choices=BotConfig.Exchange.choices,
        null=True,
        blank=True,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=BotConfig.Exchange.choices,
        null=True,
        blank=True,
    )
    order_type = models.CharField(
        "order type",
        max_length=4,
        choices=BotConfig.OrderType.choices,
        null=True,
        blank=True,
    )
    status = models.CharField(
        "status",
        max_length=10,
        choices=Status.choices,
        default=Status.OPEN,
    )
    amount = models.DecimalField("trade amount", max_digits=18, decimal_places=8)
    
    # Open details
    primary_open_price = models.DecimalField("primary open price", max_digits=20, decimal_places=8)
    secondary_open_price = models.DecimalField("secondary open price", max_digits=20, decimal_places=8)
    open_spread = models.DecimalField("open spread", max_digits=10, decimal_places=4)
    opened_at = models.DateTimeField("opened at", auto_now_add=True)

    # Close details
    primary_close_price = models.DecimalField("primary close price", max_digits=20, decimal_places=8, null=True, blank=True)
    secondary_close_price = models.DecimalField("secondary close price", max_digits=20, decimal_places=8, null=True, blank=True)
    close_spread = models.DecimalField("close spread", max_digits=10, decimal_places=4, null=True, blank=True)
    profit_percentage = models.DecimalField("profit percentage", max_digits=10, decimal_places=4, null=True, blank=True)
    closed_at = models.DateTimeField("closed at", null=True, blank=True)

    class Meta:
        verbose_name = "emulation trade"
        verbose_name_plural = "emulation trades"
        ordering = ["-opened_at"]

    def __str__(self) -> str:
        label = self.coin or (self.bot.coin if self.bot else "unknown")
        return f"Trade #{self.id} for {label} ({self.status})"

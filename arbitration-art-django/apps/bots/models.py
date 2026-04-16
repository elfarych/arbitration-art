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

    class TradeMode(models.TextChoices):
        EMULATOR = "emulator", "Эмулятор"
        REAL = "real", "Реальная торговля"

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
    trade_mode = models.CharField(
        "trade mode",
        max_length=20,
        choices=TradeMode.choices,
        default=TradeMode.EMULATOR,
    )
    max_trades = models.PositiveIntegerField("max trades", default=10)
    primary_leverage = models.PositiveIntegerField("primary leverage", default=1)
    secondary_leverage = models.PositiveIntegerField("secondary leverage", default=1)
    trade_on_primary_exchange = models.BooleanField("trade on primary", default=True)
    trade_on_secondary_exchange = models.BooleanField("trade on secondary", default=True)
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


class Trade(models.Model):
    """Stores the execution cycle of a real arbitrage trade on Binance/Bybit Futures."""

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        CLOSED = "closed", "Closed"
        FORCE_CLOSED = "force_closed", "Force Closed"

    class CloseReason(models.TextChoices):
        PROFIT = "profit", "Profit target reached"
        TIMEOUT = "timeout", "Max duration exceeded"
        MANUAL = "manual", "Manually closed"
        SHUTDOWN = "shutdown", "Graceful shutdown"
        ERROR = "error", "Error during monitoring"

    coin = models.CharField("coin", max_length=50)
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=50,
        choices=BotConfig.Exchange.choices,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=BotConfig.Exchange.choices,
    )
    order_type = models.CharField(
        "order type",
        max_length=4,
        choices=BotConfig.OrderType.choices,
    )
    status = models.CharField(
        "status",
        max_length=20,
        choices=Status.choices,
        default=Status.OPEN,
    )
    close_reason = models.CharField(
        "close reason",
        max_length=20,
        choices=CloseReason.choices,
        null=True,
        blank=True,
    )

    amount = models.DecimalField("coin amount", max_digits=18, decimal_places=8)
    leverage = models.PositiveIntegerField("leverage used", default=1)

    # Open details — actual data from exchange responses
    primary_open_price = models.DecimalField(
        "primary open price", max_digits=20, decimal_places=8
    )
    secondary_open_price = models.DecimalField(
        "secondary open price", max_digits=20, decimal_places=8
    )
    primary_open_order_id = models.CharField(
        "primary open order ID", max_length=100, null=True, blank=True
    )
    secondary_open_order_id = models.CharField(
        "secondary open order ID", max_length=100, null=True, blank=True
    )
    open_spread = models.DecimalField("open spread", max_digits=10, decimal_places=4)
    open_commission = models.DecimalField(
        "total open commission (USDT)",
        max_digits=12,
        decimal_places=6,
        default=0,
    )
    opened_at = models.DateTimeField("opened at", auto_now_add=True)

    # Close details — actual data from exchange responses
    primary_close_price = models.DecimalField(
        "primary close price",
        max_digits=20,
        decimal_places=8,
        null=True,
        blank=True,
    )
    secondary_close_price = models.DecimalField(
        "secondary close price",
        max_digits=20,
        decimal_places=8,
        null=True,
        blank=True,
    )
    primary_close_order_id = models.CharField(
        "primary close order ID", max_length=100, null=True, blank=True
    )
    secondary_close_order_id = models.CharField(
        "secondary close order ID", max_length=100, null=True, blank=True
    )
    close_spread = models.DecimalField(
        "close spread", max_digits=10, decimal_places=4, null=True, blank=True
    )
    close_commission = models.DecimalField(
        "total close commission (USDT)",
        max_digits=12,
        decimal_places=6,
        null=True,
        blank=True,
    )
    profit_usdt = models.DecimalField(
        "profit (USDT)", max_digits=12, decimal_places=6, null=True, blank=True
    )
    profit_percentage = models.DecimalField(
        "profit (%)", max_digits=10, decimal_places=4, null=True, blank=True
    )
    closed_at = models.DateTimeField("closed at", null=True, blank=True)

    class Meta:
        verbose_name = "trade"
        verbose_name_plural = "trades"
        ordering = ["-opened_at"]

    def __str__(self) -> str:
        return f"Trade #{self.id} {self.coin} ({self.status})"

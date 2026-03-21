from django.conf import settings
from django.db import models


class BotConfig(models.Model):
    """Arbitrage bot configuration card."""

    class Exchange(models.TextChoices):
        BINANCE_FUTURES = "binance_futures", "Binance Futures"
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

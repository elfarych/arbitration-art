from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.utils import timezone


def default_bot_service_url() -> str:
    """Return the default control-plane URL for bot-engine instances."""

    return getattr(settings, "BOT_ENGINE_SERVICE_URL_DEFAULT", "http://127.0.0.1:3001")


class SyncStatus(models.TextChoices):
    """Status of the latest lifecycle sync attempt."""

    IDLE = "idle", "Idle"
    PENDING = "pending", "Pending"
    SUCCESS = "success", "Success"
    FAILED = "failed", "Failed"


class RuntimeStatus(models.TextChoices):
    """Best-effort runtime state tracked by Django."""

    STOPPED = "stopped", "Stopped"
    STARTING = "starting", "Starting"
    RUNNING = "running", "Running"
    STOPPING = "stopping", "Stopping"
    ERROR = "error", "Error"
    ARCHIVED = "archived", "Archived"


class LifecycleCommand(models.TextChoices):
    """Lifecycle commands sent from Django to external services."""

    START = "start", "Start"
    SYNC = "sync", "Sync"
    STOP = "stop", "Stop"
    FORCE_CLOSE = "force-close", "Force close"


BOT_EXCHANGE_CHOICES = (
    ("binance_futures", "Binance Futures"),
    ("bybit_futures", "Bybit Futures"),
    ("gate_futures", "Gate Futures"),
    ("mexc_futures", "Mexc Futures"),
)


TRADER_EXCHANGE_CHOICES = (
    ("binance", "Binance"),
    ("bybit", "Bybit"),
    ("gate", "Gate"),
    ("mexc", "MEXC"),
)


class BotConfig(models.Model):
    """Arbitrage bot configuration card."""

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
    service_url = models.URLField(
        "service url",
        max_length=500,
        default=default_bot_service_url,
    )
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=50,
        choices=BOT_EXCHANGE_CHOICES,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=BOT_EXCHANGE_CHOICES,
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
    max_trade_duration_minutes = models.PositiveIntegerField("max trade duration (m)", default=60)
    max_leg_drawdown_percent = models.FloatField("max leg drawdown %", default=80.0)
    is_active = models.BooleanField("active", default=True)
    status = models.CharField(
        "runtime status",
        max_length=20,
        choices=RuntimeStatus.choices,
        default=RuntimeStatus.STOPPED,
    )
    sync_status = models.CharField(
        "sync status",
        max_length=20,
        choices=SyncStatus.choices,
        default=SyncStatus.IDLE,
    )
    last_command = models.CharField(
        "last command",
        max_length=20,
        choices=LifecycleCommand.choices,
        blank=True,
    )
    last_sync_error = models.TextField("last sync error", blank=True)
    last_synced_at = models.DateTimeField("last synced at", null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "bot configuration"
        verbose_name_plural = "bot configurations"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.coin} | {self.primary_exchange} → {self.secondary_exchange}"


class TraderRuntimeConfig(models.Model):
    """Managed runtime configuration for the standalone trader service."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="trader_runtime_configs",
        verbose_name="owner",
    )
    name = models.CharField("name", max_length=255)
    service_url = models.URLField("service url", max_length=500)
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=20,
        choices=TRADER_EXCHANGE_CHOICES,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=20,
        choices=TRADER_EXCHANGE_CHOICES,
    )
    use_testnet = models.BooleanField("use testnet", default=False)
    trade_amount_usdt = models.DecimalField(
        "trade amount (USDT)",
        max_digits=18,
        decimal_places=8,
    )
    leverage = models.PositiveIntegerField("leverage", default=10)
    max_concurrent_trades = models.PositiveIntegerField("max concurrent trades", default=3)
    top_liquid_pairs_count = models.PositiveIntegerField("top liquid pairs count", default=100)
    max_trade_duration_minutes = models.PositiveIntegerField("max trade duration (m)", default=60)
    max_leg_drawdown_percent = models.DecimalField(
        "max leg drawdown %",
        max_digits=6,
        decimal_places=2,
        default=80,
    )
    open_threshold = models.DecimalField("open threshold", max_digits=10, decimal_places=4)
    close_threshold = models.DecimalField("close threshold", max_digits=10, decimal_places=4)
    orderbook_limit = models.PositiveIntegerField("orderbook limit", default=50)
    chunk_size = models.PositiveIntegerField("chunk size", default=10)
    is_active = models.BooleanField("active", default=False)
    status = models.CharField(
        "runtime status",
        max_length=20,
        choices=RuntimeStatus.choices,
        default=RuntimeStatus.STOPPED,
    )
    sync_status = models.CharField(
        "sync status",
        max_length=20,
        choices=SyncStatus.choices,
        default=SyncStatus.IDLE,
    )
    last_command = models.CharField(
        "last command",
        max_length=20,
        choices=LifecycleCommand.choices,
        blank=True,
    )
    last_sync_error = models.TextField("last sync error", blank=True)
    last_synced_at = models.DateTimeField("last synced at", null=True, blank=True)
    is_deleted = models.BooleanField("is deleted", default=False)
    archived_at = models.DateTimeField("archived at", null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "trader runtime configuration"
        verbose_name_plural = "trader runtime configurations"
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=~Q(primary_exchange=F("secondary_exchange")),
                name="trader_runtime_config_distinct_exchanges",
            ),
            models.UniqueConstraint(
                fields=("owner",),
                condition=Q(is_deleted=False),
                name="unique_active_trader_runtime_config_per_owner",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} [{self.owner}]"

    def archive(self) -> None:
        """Archive the runtime config instead of deleting it physically."""

        if self.is_deleted:
            return

        if self.pk is None:
            raise ValueError("TraderRuntimeConfig must be saved before archive().")

        should_stop_runtime = self.is_active or self.status not in {
            RuntimeStatus.STOPPED,
            RuntimeStatus.ARCHIVED,
        }
        if should_stop_runtime:
            from apps.bots.services.lifecycle import sync_trader_runtime_lifecycle

            sync_trader_runtime_lifecycle(self.pk, LifecycleCommand.STOP)

        archived_at = self.archived_at or timezone.now()
        updated_at = timezone.now()

        type(self).objects.filter(pk=self.pk).update(
            is_active=False,
            is_deleted=True,
            archived_at=archived_at,
            status=RuntimeStatus.ARCHIVED,
            updated_at=updated_at,
        )

        self.is_active = False
        self.is_deleted = True
        self.archived_at = archived_at
        self.status = RuntimeStatus.ARCHIVED
        self.updated_at = updated_at


class TraderRuntimeConfigError(models.Model):
    """Error reported by the standalone trader for a runtime configuration."""

    class ErrorType(models.TextChoices):
        START = "start", "Start"
        SYNC = "sync", "Sync"
        STOP = "stop", "Stop"
        RUNTIME = "runtime", "Runtime"
        EXCHANGE_HEALTH = "exchange_health", "Exchange health"
        DIAGNOSTICS = "diagnostics", "Diagnostics"
        VALIDATION = "validation", "Validation"
        CONTROL_PLANE = "control_plane", "Control plane"

    runtime_config = models.ForeignKey(
        TraderRuntimeConfig,
        on_delete=models.CASCADE,
        related_name="errors",
        verbose_name="runtime configuration",
    )
    error_type = models.CharField(
        "error type",
        max_length=50,
        choices=ErrorType.choices,
    )
    error_text = models.TextField("error text")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "trader runtime configuration error"
        verbose_name_plural = "trader runtime configuration errors"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.runtime_config_id} | {self.error_type} | {self.created_at}"


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
        choices=BOT_EXCHANGE_CHOICES,
        null=True,
        blank=True,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=BOT_EXCHANGE_CHOICES,
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
    primary_close_price = models.DecimalField("primary close price", max_digits=20, decimal_places=8, null=True,
                                              blank=True)
    secondary_close_price = models.DecimalField("secondary close price", max_digits=20, decimal_places=8, null=True,
                                                blank=True)
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
    """Stores the execution cycle of a real arbitrage trade."""

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

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="trades",
        verbose_name="owner",
        null=True,
        blank=True,
    )
    bot = models.ForeignKey(
        BotConfig,
        on_delete=models.SET_NULL,
        related_name="real_trades",
        verbose_name="bot configuration",
        null=True,
        blank=True,
    )
    runtime_config = models.ForeignKey(
        TraderRuntimeConfig,
        on_delete=models.SET_NULL,
        related_name="trades",
        verbose_name="runtime configuration",
        null=True,
        blank=True,
    )
    coin = models.CharField("coin", max_length=50)
    primary_exchange = models.CharField(
        "primary exchange",
        max_length=50,
        choices=BOT_EXCHANGE_CHOICES,
    )
    secondary_exchange = models.CharField(
        "secondary exchange",
        max_length=50,
        choices=BOT_EXCHANGE_CHOICES,
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
        constraints = [
            models.CheckConstraint(
                condition=~(Q(bot__isnull=False) & Q(runtime_config__isnull=False)),
                name="trade_single_runtime_source",
            ),
        ]

    def __str__(self) -> str:
        return f"Trade #{self.id} {self.coin} ({self.status})"

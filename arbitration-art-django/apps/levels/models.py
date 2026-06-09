from django.conf import settings
from django.db import models


class LevelAnalysis(models.Model):
    """A saved breakout-analysis run for one coin, owned by a user.

    The run is computed by `levels-api` (Django proxies + persists) so analysis
    history survives reloads. Individual breakouts live in `LevelAnalysisBreakout`
    (related_name `breakouts`). Candle/trade times are stored as integer ms
    (Unix), matching the analysis API contract; prices/percents are floats —
    research data, precision is not money-critical. Runs are immutable.
    """

    class Direction(models.TextChoices):
        UP = "up", "up"
        DOWN = "down", "down"
        BOTH = "both", "both"

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="level_analyses",
    )
    symbol = models.CharField(max_length=40)
    timeframe = models.CharField(max_length=8)

    # Request parameters (as echoed by levels-api after defaults/caps).
    natr_multiplier = models.FloatField()
    min_gap = models.PositiveIntegerField()
    direction = models.CharField(max_length=4, choices=Direction.choices)
    max_breakout_seconds = models.PositiveIntegerField()
    min_move_pct = models.FloatField()
    candles = models.PositiveIntegerField()

    candles_analyzed = models.PositiveIntegerField()
    range_from = models.BigIntegerField()  # first candle open time, ms
    range_to = models.BigIntegerField()  # last candle open time, ms

    # Summary totals.
    breakouts_found = models.PositiveIntegerField()
    evaluated = models.PositiveIntegerField()
    matched = models.PositiveIntegerField()
    unmatched = models.PositiveIntegerField()
    match_rate = models.FloatField()
    up_found = models.PositiveIntegerField()
    up_matched = models.PositiveIntegerField()
    down_found = models.PositiveIntegerField()
    down_matched = models.PositiveIntegerField()

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["owner", "symbol", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.symbol} {self.timeframe} ({self.created_at:%Y-%m-%d %H:%M})"


class FavoriteCoin(models.Model):
    """A coin a user pinned as a favorite on the levels screener.

    Per-user watchlist of symbols. The screener fronts this with a star toggle on
    each chart card and a "pin favorites to the top" filter. `symbol` is stored
    uppercased (matching the screener) and is unique per owner, so the API can be
    addressed by symbol (`/favorites/BTCUSDT/`) without tracking row ids.
    """

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="favorite_coins",
    )
    symbol = models.CharField(max_length=40)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "symbol"], name="unique_favorite_per_owner"
            )
        ]
        indexes = [models.Index(fields=["owner", "symbol"])]

    def __str__(self) -> str:
        return f"{self.symbol} ({self.owner})"


class LevelNotificationConfig(models.Model):
    """Per-user Telegram notification settings for the levels screener.

    Exactly one config per user (OneToOne). The `level-notifier` service reads all
    enabled configs that have a chat_id over the service-token channel and, every
    ~10s, alerts the user when a coin's price comes within `distance_value` of an
    active horizontal level. The level-detection parameters mirror the screener
    filters (`natr_multiplier` / `min_gap` / `min_volume`) so alerts match what the
    user sees on the screen. Notification de-duplication state lives in Redis,
    owned by the notifier — it is intentionally NOT stored here, so the service
    never writes back to Django.
    """

    class DistanceMode(models.TextChoices):
        PCT = "pct", "pct"
        NATR = "natr", "natr"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="level_notification_config",
    )
    enabled = models.BooleanField(default=False)
    only_favorites = models.BooleanField(default=False)
    timeframe = models.CharField(max_length=8, default="1m")
    # Level-detection params — same meaning as the screener filters, so the alert
    # fires on the same levels the screener would show for these settings.
    natr_multiplier = models.FloatField(default=0.3)  # touch-zone tolerance in NATR units
    min_gap = models.PositiveIntegerField(default=12)  # min candles between touches
    min_volume = models.FloatField(default=0)  # min USDT turnover; 0 = off
    # Proximity trigger: alert when the nearest active level is within
    # `distance_value`, measured in percent or in NATR units per `distance_mode`.
    distance_mode = models.CharField(
        max_length=4, choices=DistanceMode.choices, default=DistanceMode.PCT
    )
    distance_value = models.FloatField(default=1.0)
    chat_id = models.CharField(max_length=64, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "level notification config"
        verbose_name_plural = "level notification configs"

    def __str__(self) -> str:
        state = "on" if self.enabled else "off"
        return f"{self.user.email} level notifications ({state})"


class LevelAnalysisBreakout(models.Model):
    """One detected breakout inside a `LevelAnalysis` (mirrors the API breakout)."""

    class Kind(models.TextChoices):
        TOP = "top", "top"
        BOTTOM = "bottom", "bottom"

    class Direction(models.TextChoices):
        UP = "up", "up"
        DOWN = "down", "down"

    analysis = models.ForeignKey(
        LevelAnalysis,
        on_delete=models.CASCADE,
        related_name="breakouts",
    )
    price = models.FloatField()
    level_time = models.BigIntegerField()  # level formation (extremum open), ms
    kind = models.CharField(max_length=6, choices=Kind.choices)
    direction = models.CharField(max_length=4, choices=Direction.choices)
    touches = models.PositiveIntegerField()
    breakout_candle_time = models.BigIntegerField()  # candle whose wick first pierced the level, ms
    cross_time = models.BigIntegerField(null=True, blank=True)  # first trade past level
    reach_time = models.BigIntegerField(null=True, blank=True)  # reached minMovePct
    elapsed_ms = models.BigIntegerField(null=True, blank=True)  # cross → peak move
    move_pct = models.FloatField(null=True, blank=True)  # peak move beyond level
    matched = models.BooleanField()
    reason = models.CharField(max_length=32)

    class Meta:
        ordering = ["breakout_candle_time"]

    def __str__(self) -> str:
        return f"{self.direction} {self.price} @ {self.breakout_candle_time}"

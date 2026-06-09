import math

from rest_framework import serializers

from apps.levels.models import (
    FavoriteCoin,
    LevelAnalysis,
    LevelAnalysisBreakout,
    LevelNotificationConfig,
    PriceNotification,
)


class FavoriteCoinSerializer(serializers.ModelSerializer):
    """One favorite coin. Input is just `symbol`; it is normalized to uppercase so
    it matches the screener symbols and the per-owner uniqueness constraint."""

    createdAt = serializers.DateTimeField(source="created_at", read_only=True)

    class Meta:
        model = FavoriteCoin
        fields = ["id", "symbol", "createdAt"]
        read_only_fields = ["id", "createdAt"]

    def validate_symbol(self, value: str) -> str:
        symbol = value.strip().upper()
        if not symbol:
            raise serializers.ValidationError("Symbol must not be empty.")
        return symbol

# Output is camelCase and nested (params/range/summary/byDirection) to match the
# levels-api AnalysisResult contract the frontend already consumes — so the same
# components render saved analyses and live ones without remapping.


class AnalysisRunSerializer(serializers.Serializer):
    """Input for POST /levels/analyses/ — params to run + persist an analysis.

    natrMultiplier / minGap / candles are optional: omitted → levels-api uses its
    own env defaults (the viewset forwards only the provided ones).
    """

    symbol = serializers.CharField(max_length=40)
    timeframe = serializers.CharField(max_length=8)
    natrMultiplier = serializers.FloatField(required=False, min_value=0)
    minGap = serializers.IntegerField(required=False, min_value=1)
    direction = serializers.ChoiceField(
        choices=["up", "down", "both"], required=False, default="both"
    )
    maxBreakoutSeconds = serializers.IntegerField(required=False, min_value=1, default=300)
    minMovePct = serializers.FloatField(required=False, min_value=0, default=0.5)
    candles = serializers.IntegerField(required=False, min_value=61)


class BreakoutSerializer(serializers.ModelSerializer):
    levelTime = serializers.IntegerField(source="level_time")
    breakoutCandleTime = serializers.IntegerField(source="breakout_candle_time")
    crossTime = serializers.IntegerField(source="cross_time", allow_null=True)
    reachTime = serializers.IntegerField(source="reach_time", allow_null=True)
    elapsedMs = serializers.IntegerField(source="elapsed_ms", allow_null=True)
    movePct = serializers.FloatField(source="move_pct", allow_null=True)

    class Meta:
        model = LevelAnalysisBreakout
        fields = [
            "price",
            "levelTime",
            "kind",
            "direction",
            "touches",
            "breakoutCandleTime",
            "crossTime",
            "reachTime",
            "elapsedMs",
            "movePct",
            "matched",
            "reason",
        ]


class AnalysisSummarySerializer(serializers.ModelSerializer):
    """List row: identity + params + range + totals (no breakouts)."""

    createdAt = serializers.DateTimeField(source="created_at")
    candlesAnalyzed = serializers.IntegerField(source="candles_analyzed")
    params = serializers.SerializerMethodField()
    range = serializers.SerializerMethodField()
    summary = serializers.SerializerMethodField()

    class Meta:
        model = LevelAnalysis
        fields = ["id", "symbol", "timeframe", "createdAt", "candlesAnalyzed", "params", "range", "summary"]

    def get_params(self, obj: LevelAnalysis) -> dict:
        return {
            "natrMultiplier": obj.natr_multiplier,
            "minGap": obj.min_gap,
            "direction": obj.direction,
            "maxBreakoutSeconds": obj.max_breakout_seconds,
            "minMovePct": obj.min_move_pct,
            "candles": obj.candles,
        }

    def get_range(self, obj: LevelAnalysis) -> dict:
        return {"from": obj.range_from, "to": obj.range_to}

    def get_summary(self, obj: LevelAnalysis) -> dict:
        return {
            "breakoutsFound": obj.breakouts_found,
            "evaluated": obj.evaluated,
            "matched": obj.matched,
            "unmatched": obj.unmatched,
            "matchRate": obj.match_rate,
            "byDirection": {
                "up": {"found": obj.up_found, "matched": obj.up_matched},
                "down": {"found": obj.down_found, "matched": obj.down_matched},
            },
        }


class AnalysisDetailSerializer(AnalysisSummarySerializer):
    """Detail: summary + the full breakouts list."""

    breakouts = BreakoutSerializer(many=True, read_only=True)

    class Meta(AnalysisSummarySerializer.Meta):
        fields = AnalysisSummarySerializer.Meta.fields + ["breakouts"]


class _BreakoutInputSerializer(serializers.Serializer):
    """Validates one browser-computed breakout before persistence (camelCase wire)."""

    price = serializers.FloatField()
    levelTime = serializers.IntegerField()
    kind = serializers.ChoiceField(choices=["top", "bottom"])
    direction = serializers.ChoiceField(choices=["up", "down"])
    touches = serializers.IntegerField(min_value=0)
    breakoutCandleTime = serializers.IntegerField()
    crossTime = serializers.IntegerField(allow_null=True)
    reachTime = serializers.IntegerField(allow_null=True)
    elapsedMs = serializers.IntegerField(allow_null=True)
    movePct = serializers.FloatField(allow_null=True)
    matched = serializers.BooleanField()
    reason = serializers.ChoiceField(
        choices=["ok", "no_trades", "no_cross", "min_move_not_reached", "too_slow"]
    )


class _ParamsInputSerializer(serializers.Serializer):
    natrMultiplier = serializers.FloatField(min_value=0)
    minGap = serializers.IntegerField(min_value=1)
    direction = serializers.ChoiceField(choices=["up", "down", "both"])
    maxBreakoutSeconds = serializers.IntegerField(min_value=1)
    minMovePct = serializers.FloatField(min_value=0)
    candles = serializers.IntegerField(min_value=1)


class AnalysisSaveSerializer(serializers.Serializer):
    """Input for POST /levels/analyses/ — a browser-computed AnalysisResult.

    The analysis is computed client-side (frontend src/stores/levels/compute),
    so this is user-supplied data (accepted trust tradeoff). Structure and field
    domains are validated here; the client `summary` is NOT trusted — the viewset
    recomputes it from `breakouts`. Unknown extra keys (e.g. a client summary) are
    ignored by DRF.
    """

    MAX_BREAKOUTS = 2000

    symbol = serializers.CharField(max_length=40)
    timeframe = serializers.CharField(max_length=8)
    candlesAnalyzed = serializers.IntegerField(min_value=1)
    params = _ParamsInputSerializer()
    # 'from'/'to' are not valid Python identifiers, so range is a dict, not a
    # nested serializer.
    range = serializers.DictField(child=serializers.IntegerField())
    breakouts = _BreakoutInputSerializer(many=True)

    def validate_range(self, value):
        if "from" not in value or "to" not in value:
            raise serializers.ValidationError("range must contain 'from' and 'to'.")
        return value

    def validate_breakouts(self, value):
        if len(value) > self.MAX_BREAKOUTS:
            raise serializers.ValidationError(
                f"Too many breakouts (> {self.MAX_BREAKOUTS})."
            )
        return value


class LevelNotificationConfigSerializer(serializers.ModelSerializer):
    """The current user's level-notification config (camelCase wire shape).

    Used by the screener's notification dialog. `chatId` is allowed blank so other
    settings can be saved before pasting it, but the service ignores configs
    without a chat_id. Numeric domains mirror the level math: natrMultiplier > 0,
    minGap >= 1, minVolume >= 0, distanceValue > 0.
    """

    onlyFavorites = serializers.BooleanField(source="only_favorites", required=False)
    natrMultiplier = serializers.FloatField(source="natr_multiplier", required=False)
    minGap = serializers.IntegerField(source="min_gap", required=False, min_value=1)
    minVolume = serializers.FloatField(source="min_volume", required=False, min_value=0)
    distanceMode = serializers.ChoiceField(
        source="distance_mode",
        choices=LevelNotificationConfig.DistanceMode.values,
        required=False,
    )
    distanceValue = serializers.FloatField(source="distance_value", required=False)
    chatId = serializers.CharField(
        source="chat_id", required=False, allow_blank=True, max_length=64
    )
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)

    class Meta:
        model = LevelNotificationConfig
        fields = [
            "enabled",
            "onlyFavorites",
            "timeframe",
            "natrMultiplier",
            "minGap",
            "minVolume",
            "distanceMode",
            "distanceValue",
            "chatId",
            "updatedAt",
        ]

    def validate_natrMultiplier(self, value: float) -> float:
        if value <= 0:
            raise serializers.ValidationError("natrMultiplier must be > 0.")
        return value

    def validate_distanceValue(self, value: float) -> float:
        if value <= 0:
            raise serializers.ValidationError("distanceValue must be > 0.")
        return value

    def validate_timeframe(self, value: str) -> str:
        timeframe = value.strip()
        if not timeframe:
            raise serializers.ValidationError("timeframe must not be empty.")
        return timeframe


class ServiceNotificationConfigSerializer(serializers.ModelSerializer):
    """Read-only projection of an active config for the `level-notifier` service.

    Adds `ownerId` and the owner's favorite symbols (prefetched by the view) so the
    service can scope to favorites without a second request. Service-token only;
    exposes `chatId` over the internal channel.
    """

    ownerId = serializers.IntegerField(source="user_id", read_only=True)
    onlyFavorites = serializers.BooleanField(source="only_favorites")
    natrMultiplier = serializers.FloatField(source="natr_multiplier")
    minGap = serializers.IntegerField(source="min_gap")
    minVolume = serializers.FloatField(source="min_volume")
    distanceMode = serializers.CharField(source="distance_mode")
    distanceValue = serializers.FloatField(source="distance_value")
    chatId = serializers.CharField(source="chat_id")
    favorites = serializers.SerializerMethodField()

    class Meta:
        model = LevelNotificationConfig
        fields = [
            "ownerId",
            "enabled",
            "onlyFavorites",
            "timeframe",
            "natrMultiplier",
            "minGap",
            "minVolume",
            "distanceMode",
            "distanceValue",
            "chatId",
            "favorites",
        ]

    def get_favorites(self, obj: LevelNotificationConfig) -> list[str]:
        # Prefetched via the view (user__favorite_coins) — no extra query per row.
        return [favorite.symbol for favorite in obj.user.favorite_coins.all()]


class PriceNotificationSerializer(serializers.ModelSerializer):
    """One user-owned price alert (camelCase wire shape).

    `direction` is supplied by the client, inferred from the click position vs the
    current price (above = price must rise to target, below = must fall). `symbol`
    is normalized to uppercase to match the screener. `enabled` is writable so the
    widget can re-arm a fired alert; clearing `triggered_at` on re-arm is handled
    in the viewset.
    """

    targetPrice = serializers.FloatField(source="target_price")
    triggeredAt = serializers.DateTimeField(source="triggered_at", read_only=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)

    class Meta:
        model = PriceNotification
        fields = [
            "id",
            "symbol",
            "targetPrice",
            "direction",
            "enabled",
            "triggeredAt",
            "createdAt",
            "updatedAt",
        ]
        read_only_fields = ["id", "triggeredAt", "createdAt", "updatedAt"]

    def validate_symbol(self, value: str) -> str:
        symbol = value.strip().upper()
        if not symbol:
            raise serializers.ValidationError("Symbol must not be empty.")
        return symbol

    def validate_targetPrice(self, value: float) -> float:
        # Reject NaN/Infinity (a string body like "Infinity" coerces via float()
        # and would otherwise slip past the > 0 check, creating a dead alert).
        if not math.isfinite(value):
            raise serializers.ValidationError("targetPrice must be a finite number.")
        if value <= 0:
            raise serializers.ValidationError("targetPrice must be > 0.")
        return value


class ServicePriceNotificationSerializer(serializers.ModelSerializer):
    """Read-only projection of an active price alert for the `level-notifier`
    service. Adds `ownerId` and the owner's Telegram `chatId` (reused from their
    LevelNotificationConfig, select_related by the view) so the service can deliver
    without a second request. Service-token only."""

    ownerId = serializers.IntegerField(source="owner_id", read_only=True)
    targetPrice = serializers.FloatField(source="target_price")
    chatId = serializers.SerializerMethodField()

    class Meta:
        model = PriceNotification
        fields = ["id", "ownerId", "symbol", "targetPrice", "direction", "chatId"]

    def get_chatId(self, obj: PriceNotification) -> str:
        # Reverse OneToOne may be absent; the view already filters to owners that
        # have a non-empty chat_id, this is a defensive fallback.
        config = getattr(obj.owner, "level_notification_config", None)
        return config.chat_id if config else ""

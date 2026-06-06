from rest_framework import serializers

from apps.levels.models import LevelAnalysis, LevelAnalysisBreakout

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

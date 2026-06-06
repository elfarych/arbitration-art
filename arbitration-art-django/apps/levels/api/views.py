from typing import Any

from rest_framework import status, viewsets
from rest_framework.exceptions import APIException
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.levels.api.serializers import (
    AnalysisDetailSerializer,
    AnalysisRunSerializer,
    AnalysisSummarySerializer,
)
from apps.levels.models import LevelAnalysis, LevelAnalysisBreakout
from apps.levels.services.analysis_client import LevelsAnalysisError, run_analysis


class AnalysisServiceError(APIException):
    """502 wrapper for levels-api failures (bad symbol/tf, not enough candles, upstream)."""

    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = "Levels analysis service failed."
    default_code = "levels_analysis_failed"


class LevelAnalysisViewSet(viewsets.ModelViewSet):
    """List / run / read / delete saved breakout analyses for the current user.

    Runs are immutable — no PUT/PATCH. `create` proxies levels-api, then persists
    the result and its breakouts under the user.
    """

    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_queryset(self):
        queryset = LevelAnalysis.objects.filter(owner=self.request.user)
        symbol = self.request.query_params.get("symbol")
        if symbol:
            queryset = queryset.filter(symbol=symbol.upper())
        if self.action == "retrieve":
            queryset = queryset.prefetch_related("breakouts")
        return queryset

    def get_serializer_class(self):
        if self.action == "retrieve":
            return AnalysisDetailSerializer
        if self.action == "create":
            return AnalysisRunSerializer
        return AnalysisSummarySerializer

    def create(self, request, *args, **kwargs):
        input_serializer = AnalysisRunSerializer(data=request.data)
        input_serializer.is_valid(raise_exception=True)
        data = input_serializer.validated_data

        symbol = data["symbol"].upper()
        timeframe = data["timeframe"]
        query: dict[str, Any] = {
            "direction": data.get("direction", "both"),
            "maxBreakoutSeconds": data.get("maxBreakoutSeconds", 300),
            "minMovePct": data.get("minMovePct", 0.5),
        }
        # Forward only provided calc params; omitted → levels-api env defaults.
        for key in ("natrMultiplier", "minGap", "candles"):
            if data.get(key) is not None:
                query[key] = data[key]

        try:
            result = run_analysis(symbol, timeframe, query)
        except LevelsAnalysisError as exc:
            raise AnalysisServiceError(detail=str(exc))

        analysis = _persist_analysis(request.user, symbol, timeframe, result)
        return Response(
            AnalysisDetailSerializer(analysis).data,
            status=status.HTTP_201_CREATED,
        )


def _persist_analysis(user, symbol: str, timeframe: str, result: dict[str, Any]) -> LevelAnalysis:
    params = result["params"]
    summary = result["summary"]
    by_direction = summary["byDirection"]
    candle_range = result["range"]

    analysis = LevelAnalysis.objects.create(
        owner=user,
        symbol=symbol,
        timeframe=timeframe,
        natr_multiplier=params["natrMultiplier"],
        min_gap=params["minGap"],
        direction=params["direction"],
        max_breakout_seconds=params["maxBreakoutSeconds"],
        min_move_pct=params["minMovePct"],
        candles=params["candles"],
        candles_analyzed=result["candlesAnalyzed"],
        range_from=candle_range["from"],
        range_to=candle_range["to"],
        breakouts_found=summary["breakoutsFound"],
        evaluated=summary["evaluated"],
        matched=summary["matched"],
        unmatched=summary["unmatched"],
        match_rate=summary["matchRate"],
        up_found=by_direction["up"]["found"],
        up_matched=by_direction["up"]["matched"],
        down_found=by_direction["down"]["found"],
        down_matched=by_direction["down"]["matched"],
    )

    LevelAnalysisBreakout.objects.bulk_create(
        [
            LevelAnalysisBreakout(
                analysis=analysis,
                price=b["price"],
                level_time=b["levelTime"],
                kind=b["kind"],
                direction=b["direction"],
                touches=b["touches"],
                breakout_candle_time=b["breakoutCandleTime"],
                cross_time=b["crossTime"],
                reach_time=b["reachTime"],
                elapsed_ms=b["elapsedMs"],
                move_pct=b["movePct"],
                matched=b["matched"],
                reason=b["reason"],
            )
            for b in result["breakouts"]
        ]
    )
    return analysis

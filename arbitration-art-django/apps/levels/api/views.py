from typing import Any

from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.levels.api.serializers import (
    AnalysisDetailSerializer,
    AnalysisSaveSerializer,
    AnalysisSummarySerializer,
    FavoriteCoinSerializer,
)
from apps.levels.models import FavoriteCoin, LevelAnalysis, LevelAnalysisBreakout


class FavoriteCoinViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """List / add / remove the current user's favorite coins.

    Addressed by `symbol` instead of row id (`DELETE /favorites/BTCUSDT/`) so the
    screener can toggle a coin's star without bookkeeping ids. The full list is
    returned unpaginated (a user's watchlist is small and the screener needs all
    of it at once to float favorites to the top).
    """

    serializer_class = FavoriteCoinSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = None
    lookup_field = "symbol"
    # Symbols are alphanumeric (e.g. 1000PEPEUSDT); the default `[^/.]+` would also
    # swallow dots, so constrain to the characters real symbols use.
    lookup_value_regex = "[A-Za-z0-9]+"

    def get_queryset(self):
        return FavoriteCoin.objects.filter(owner=self.request.user)

    def get_object(self) -> FavoriteCoin:
        # Stored symbols are uppercase; normalize the URL lookup so removal works
        # regardless of the casing the client sends.
        symbol = self.kwargs[self.lookup_field].upper()
        obj = get_object_or_404(self.get_queryset(), symbol=symbol)
        self.check_object_permissions(self.request, obj)
        return obj

    def create(self, request, *args, **kwargs):
        # Idempotent add: re-adding an existing favorite returns it (200) instead
        # of a uniqueness error — matches the star toggle, which may race.
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        favorite, created = FavoriteCoin.objects.get_or_create(
            owner=request.user, symbol=serializer.validated_data["symbol"]
        )
        out = self.get_serializer(favorite)
        return Response(
            out.data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class LevelAnalysisViewSet(viewsets.ModelViewSet):
    """List / save / read / delete saved breakout analyses for the current user.

    The analysis itself is computed in the browser (frontend fetches candles +
    trades from Binance directly) to offload server CPU and distribute Binance's
    per-IP weight limit across users. `create` persists the client-computed
    result. Accepted trust tradeoff: the breakouts are user-supplied and cannot be
    re-verified without Binance, but the `summary` is recomputed server-side from
    them (so the aggregates can't be forged and stay consistent). Runs are
    immutable — no PUT/PATCH.

    A server-side compute path still exists as a fallback (levels-api
    `GET /analysis/:tf/:symbol` + `services/analysis_client.run_analysis`) but is
    no longer wired into this viewset.
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
            return AnalysisSaveSerializer
        return AnalysisSummarySerializer

    def create(self, request, *args, **kwargs):
        serializer = AnalysisSaveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        analysis = _persist_analysis(
            request.user, data["symbol"].upper(), data["timeframe"], data
        )
        return Response(
            AnalysisDetailSerializer(analysis).data,
            status=status.HTTP_201_CREATED,
        )


def _build_summary(breakouts: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate stats recomputed server-side from the breakouts (the client
    summary is not trusted). Mirrors levels-api `buildSummary`."""
    matched = sum(1 for b in breakouts if b["matched"])
    evaluated = sum(1 for b in breakouts if b["reason"] != "no_trades")
    up = [b for b in breakouts if b["direction"] == "up"]
    down = [b for b in breakouts if b["direction"] == "down"]
    return {
        "breakouts_found": len(breakouts),
        "evaluated": evaluated,
        "matched": matched,
        "unmatched": evaluated - matched,
        "match_rate": (matched / evaluated) if evaluated > 0 else 0.0,
        "up_found": len(up),
        "up_matched": sum(1 for b in up if b["matched"]),
        "down_found": len(down),
        "down_matched": sum(1 for b in down if b["matched"]),
    }


def _persist_analysis(user, symbol: str, timeframe: str, result: dict[str, Any]) -> LevelAnalysis:
    params = result["params"]
    candle_range = result["range"]
    breakouts = result["breakouts"]
    summary = _build_summary(breakouts)

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
        breakouts_found=summary["breakouts_found"],
        evaluated=summary["evaluated"],
        matched=summary["matched"],
        unmatched=summary["unmatched"],
        match_rate=summary["match_rate"],
        up_found=summary["up_found"],
        up_matched=summary["up_matched"],
        down_found=summary["down_found"],
        down_matched=summary["down_matched"],
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
            for b in breakouts
        ]
    )
    return analysis

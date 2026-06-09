from typing import Any

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, mixins, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.bots.permissions import ServiceTokenOnly
from apps.levels.api.serializers import (
    AnalysisDetailSerializer,
    AnalysisSaveSerializer,
    AnalysisSummarySerializer,
    FavoriteCoinSerializer,
    LevelNotificationConfigSerializer,
    PriceNotificationSerializer,
    ServiceNotificationConfigSerializer,
    ServicePriceNotificationSerializer,
)
from apps.levels.models import (
    FavoriteCoin,
    LevelAnalysis,
    LevelAnalysisBreakout,
    LevelNotificationConfig,
    PriceNotification,
)


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


class LevelNotificationConfigView(generics.RetrieveUpdateAPIView):
    """Return / update the current user's level-notification config (singleton).

    One config per user: `get_object` creates it lazily on first access (same
    pattern as `ExchangeKeysView`), so the screener dialog always has a row to read
    and PUT/PATCH.
    """

    serializer_class = LevelNotificationConfigSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self) -> LevelNotificationConfig:
        config, _ = LevelNotificationConfig.objects.get_or_create(user=self.request.user)
        return config


class ServiceNotificationConfigsView(generics.ListAPIView):
    """All active notification configs for the `level-notifier` service.

    Service-token only (no JWT). Returns enabled configs that have a chat_id, each
    with the owner's favorite symbols (prefetched). Wrapped in `{"configs": [...]}`
    to match the engine-bootstrap envelope style.
    """

    serializer_class = ServiceNotificationConfigSerializer
    permission_classes = [ServiceTokenOnly]
    pagination_class = None

    def get_queryset(self):
        return (
            LevelNotificationConfig.objects.filter(enabled=True)
            .exclude(chat_id="")
            .select_related("user")
            .prefetch_related("user__favorite_coins")
            .order_by("user_id")
        )

    def list(self, request, *args, **kwargs) -> Response:
        serializer = self.get_serializer(self.get_queryset(), many=True)
        return Response({"configs": serializer.data})


class PriceNotificationViewSet(viewsets.ModelViewSet):
    """CRUD over the current user's price alerts (a collection, addressed by id).

    Created mostly by right-clicking a price on the screener chart. PATCH lets the
    widget re-arm a fired alert (toggling `enabled` back on) or move a target; re-
    arming clears `triggered_at`. Unpaginated — a user's alert list is small and
    the screener needs all of it to overlay lines on the charts.
    """

    serializer_class = PriceNotificationSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        queryset = PriceNotification.objects.filter(owner=self.request.user)
        symbol = self.request.query_params.get("symbol")
        if symbol:
            queryset = queryset.filter(symbol=symbol.upper())
        return queryset

    def perform_create(self, serializer) -> None:
        serializer.save(owner=self.request.user)

    def perform_update(self, serializer) -> None:
        # Re-arming a fired alert from the widget (enabled flipped back on) clears
        # the previous trigger timestamp so it shows as active again.
        if serializer.validated_data.get("enabled") is True:
            serializer.save(triggered_at=None)
        else:
            serializer.save()


class ServicePriceNotificationsView(generics.ListAPIView):
    """All active price alerts for the `level-notifier` service.

    Service-token only. Returns enabled alerts whose owner has a Telegram chat_id
    (reused from their LevelNotificationConfig) — the service cannot deliver
    without one. Wrapped in `{"notifications": [...]}` to match the configs
    envelope.
    """

    serializer_class = ServicePriceNotificationSerializer
    permission_classes = [ServiceTokenOnly]
    pagination_class = None

    def get_queryset(self):
        return (
            PriceNotification.objects.filter(enabled=True)
            .filter(owner__level_notification_config__chat_id__gt="")
            .select_related("owner__level_notification_config")
            .order_by("owner_id")
        )

    def list(self, request, *args, **kwargs) -> Response:
        serializer = self.get_serializer(self.get_queryset(), many=True)
        return Response({"notifications": serializer.data})


class ServicePriceNotificationTriggerView(APIView):
    """Mark a price alert as fired (one-shot): the `level-notifier` calls this after
    sending the Telegram alert. Sets `enabled=False` + `triggered_at`. Service-token
    only; idempotent."""

    permission_classes = [ServiceTokenOnly]

    def post(self, request, pk: int, *args, **kwargs) -> Response:
        notification = get_object_or_404(PriceNotification, pk=pk)
        notification.enabled = False
        notification.triggered_at = timezone.now()
        notification.save(update_fields=["enabled", "triggered_at", "updated_at"])
        return Response(status=status.HTTP_200_OK)

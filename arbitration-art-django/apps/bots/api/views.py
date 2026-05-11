from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.bots.api.serializers import (
    BotConfigSerializer,
    EmulationTradeSerializer,
    TradeSerializer,
    TraderRuntimeConfigErrorSerializer,
    TraderRuntimeConfigSerializer,
)
from apps.bots.models import (
    BotConfig,
    EmulationTrade,
    LifecycleCommand,
    Trade,
    TraderRuntimeConfig,
    TraderRuntimeConfigError,
)
from apps.bots.permissions import ServiceTokenOnly, ServiceTokenWriteOrAuthenticatedRead, is_service_request
from apps.bots.services.lifecycle import (
    LifecycleSyncError,
    check_bot_engine_health,
    sync_bot_lifecycle,
)
from apps.bots.services.trader_runtime_shared import build_trader_runtime_payload
from apps.bots.services.trader_runtime_info import (
    TraderRuntimeInfoError,
    fetch_trader_runtime_active_coins,
    fetch_trader_runtime_exchange_health,
    fetch_trader_runtime_open_trades_pnl,
    fetch_trader_runtime_server_info,
    fetch_trader_runtime_system_load,
    run_trader_runtime_test_trade,
)


class EngineSyncError(APIException):
    """502 wrapper for engine-side lifecycle failures.

    Raised inline from perform_create/perform_update so that a write succeeds
    in Django only after the engine has acknowledged the lifecycle command.
    The BotConfig record is still persisted with sync_status=FAILED and a
    populated last_sync_error so operators can retry without losing config.
    """

    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = "Engine lifecycle sync failed."
    default_code = "engine_sync_failed"


def _dispatch_bot_lifecycle(bot_id: int, action: str) -> None:
    try:
        sync_bot_lifecycle(bot_id, action)
    except LifecycleSyncError as exc:
        raise EngineSyncError(detail=str(exc))


class BotConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for bot configurations."""

    serializer_class = BotConfigSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return BotConfig.objects.filter(owner=self.request.user)

    def perform_create(self, serializer: BotConfigSerializer) -> None:
        # Inline lifecycle sync: the Django row exists only after the engine has
        # acknowledged the START command (or the bot was created inactive, in
        # which case no engine call is needed). This guarantees the operator
        # sees an immediate, accurate 2xx vs 502 instead of a silently
        # half-synced state from the deferred-signal approach.
        instance: BotConfig = serializer.save(owner=self.request.user)
        if instance.is_active:
            _dispatch_bot_lifecycle(instance.id, LifecycleCommand.START)

    def perform_update(self, serializer: BotConfigSerializer) -> None:
        previous_is_active = bool(serializer.instance.is_active)
        instance: BotConfig = serializer.save()
        # Engine.startBot is idempotent: it either starts a new trader or
        # forwards the new config to the existing one. Therefore a single
        # START suffices for every active-bot transition (newly active, still
        # active, config-only change). STOP is sent only when the bot moves
        # to inactive — Engine.stop closes positions gracefully.
        if instance.is_active:
            _dispatch_bot_lifecycle(instance.id, LifecycleCommand.START)
        elif previous_is_active:
            _dispatch_bot_lifecycle(instance.id, LifecycleCommand.STOP)
        # If the bot was already inactive and stays inactive, no engine call
        # is needed: no in-memory runtime exists to mutate.

    def destroy(self, request, *args, **kwargs):
        instance: BotConfig = self.get_object()
        # Stop the bot synchronously before removing the row. If the engine
        # cannot confirm shutdown we refuse to delete — otherwise positions
        # on the exchange would be orphaned with no way for the engine to
        # rediscover them (Trade.bot becomes NULL on cascade and the recovery
        # query filters by bot_id).
        if instance.is_active:
            try:
                sync_bot_lifecycle(instance.id, LifecycleCommand.STOP)
            except LifecycleSyncError as exc:
                return Response(
                    {"detail": str(exc)},
                    status=status.HTTP_502_BAD_GATEWAY,
                )
            # Mark the in-memory instance as inactive so the pre_delete signal
            # (the cascade/admin safety net) does not fire a second stop.
            instance.is_active = False
        instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="force-close")
    def force_close(self, request, pk=None):
        bot = self.get_object()
        try:
            sync_bot_lifecycle(bot.id, LifecycleCommand.FORCE_CLOSE)
        except LifecycleSyncError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({"status": "force-close triggered"})

    @action(detail=True, methods=["get"], url_path="engine-health")
    def engine_health(self, request, pk=None):
        """Probe the engine /health endpoint for this bot's service_url.

        Frontend uses this to verify the engine is reachable before triggering
        lifecycle actions, without side effects on engine state.
        """
        bot = self.get_object()
        try:
            payload = check_bot_engine_health(bot.service_url)
        except LifecycleSyncError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(payload)


class TraderRuntimeConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for standalone trader runtime configurations."""

    serializer_class = TraderRuntimeConfigSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        queryset = TraderRuntimeConfig.objects.filter(owner=self.request.user)
        include_archived = self.request.query_params.get("include_archived") == "true"
        if not include_archived:
            queryset = queryset.filter(is_deleted=False)
        return queryset

    def perform_create(self, serializer: TraderRuntimeConfigSerializer) -> None:
        serializer.save(owner=self.request.user)

    def perform_update(self, serializer: TraderRuntimeConfigSerializer) -> None:
        serializer.save()

    def perform_destroy(self, instance: TraderRuntimeConfig) -> None:
        instance.archive()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        try:
            self.perform_destroy(instance)
        except LifecycleSyncError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"], url_path="exchange-health")
    def exchange_health(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = fetch_trader_runtime_exchange_health(runtime_config.id)
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(detail=True, methods=["get"], url_path="active-coins")
    def active_coins(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = fetch_trader_runtime_active_coins(runtime_config.id)
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(detail=True, methods=["get"], url_path="open-trades-pnl")
    def open_trades_pnl(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = fetch_trader_runtime_open_trades_pnl(runtime_config.id)
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(detail=True, methods=["get"], url_path="system-load")
    def system_load(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = fetch_trader_runtime_system_load(runtime_config.id)
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(detail=True, methods=["get"], url_path="server-info")
    def server_info(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = fetch_trader_runtime_server_info(runtime_config.id)
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(detail=True, methods=["post"], url_path="test-trade")
    def test_trade(self, request, pk=None):
        runtime_config = self.get_object()
        try:
            payload = run_trader_runtime_test_trade(
                runtime_config.id,
                amount_usdt=request.data.get("amount_usdt"),
            )
        except TraderRuntimeInfoError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(payload)

    @action(
        detail=True,
        methods=["get"],
        url_path="active-payload",
        permission_classes=[ServiceTokenOnly],
    )
    def active_payload(self, request, pk=None):
        runtime_config = (
            TraderRuntimeConfig.objects.select_related("owner", "owner__exchange_keys")
            .filter(pk=pk, is_active=True, is_deleted=False)
            .first()
        )
        if runtime_config is None:
            return Response(status=status.HTTP_204_NO_CONTENT)

        return Response(build_trader_runtime_payload(runtime_config))


class TraderRuntimeConfigErrorViewSet(viewsets.ModelViewSet):
    """Read user-owned runtime errors and allow service-token writes."""

    serializer_class = TraderRuntimeConfigErrorSerializer
    permission_classes = [ServiceTokenWriteOrAuthenticatedRead]

    def get_queryset(self):
        queryset = TraderRuntimeConfigError.objects.select_related(
            "runtime_config",
            "runtime_config__owner",
        )

        if is_service_request(self.request):
            pass
        elif self.request.user.is_authenticated:
            queryset = queryset.filter(runtime_config__owner=self.request.user)
        else:
            queryset = queryset.none()

        runtime_config_id = self.request.query_params.get("runtime_config_id")
        if runtime_config_id:
            queryset = queryset.filter(runtime_config_id=runtime_config_id)

        error_type = self.request.query_params.get("error_type")
        if error_type:
            queryset = queryset.filter(error_type=error_type)

        return queryset


class EmulationTradeViewSet(viewsets.ModelViewSet):
    """Read user-owned emulation trades and allow service-token writes."""

    serializer_class = EmulationTradeSerializer
    permission_classes = [ServiceTokenWriteOrAuthenticatedRead]

    def get_queryset(self):
        queryset = EmulationTrade.objects.select_related("bot", "bot__owner")

        if is_service_request(self.request):
            pass
        elif self.request.user.is_authenticated:
            queryset = queryset.filter(bot__owner=self.request.user)
        else:
            queryset = queryset.none()

        status_value = self.request.query_params.get("status")
        if status_value:
            queryset = queryset.filter(status=status_value)

        bot_id = self.request.query_params.get("bot_id")
        if bot_id:
            queryset = queryset.filter(bot_id=bot_id)

        return queryset


class TradeViewSet(viewsets.ModelViewSet):
    """Read user-owned trades and allow service-token writes."""

    serializer_class = TradeSerializer
    permission_classes = [ServiceTokenWriteOrAuthenticatedRead]

    def get_queryset(self):
        queryset = Trade.objects.select_related("owner", "bot", "runtime_config")

        if is_service_request(self.request):
            pass
        elif self.request.user.is_authenticated:
            queryset = queryset.filter(owner=self.request.user)
        else:
            queryset = queryset.none()

        status_value = self.request.query_params.get("status")
        if status_value:
            queryset = queryset.filter(status=status_value)

        bot_id = self.request.query_params.get("bot_id")
        if bot_id:
            queryset = queryset.filter(bot_id=bot_id)

        runtime_config_id = self.request.query_params.get("runtime_config_id")
        if runtime_config_id:
            queryset = queryset.filter(runtime_config_id=runtime_config_id)

        return queryset

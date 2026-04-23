from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.bots.api.serializers import (
    BotConfigSerializer,
    EmulationTradeSerializer,
    TradeSerializer,
    TraderRuntimeConfigSerializer,
)
from apps.bots.models import BotConfig, EmulationTrade, Trade, TraderRuntimeConfig
from apps.bots.permissions import ServiceTokenWriteOrAuthenticatedRead, is_service_request
from apps.bots.services.lifecycle import LifecycleSyncError, sync_bot_lifecycle


class BotConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for bot configurations."""

    serializer_class = BotConfigSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return BotConfig.objects.filter(owner=self.request.user)

    def perform_create(self, serializer: BotConfigSerializer) -> None:
        serializer.save(owner=self.request.user)

    def perform_update(self, serializer: BotConfigSerializer) -> None:
        serializer.save()

    def perform_destroy(self, instance: BotConfig) -> None:
        instance.delete()

    @action(detail=True, methods=["post"], url_path="force-close")
    def force_close(self, request, pk=None):
        bot = self.get_object()
        try:
            sync_bot_lifecycle(bot.id, "force-close")
        except LifecycleSyncError as exc:
            return Response(
                {"detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({"status": "force-close triggered"})


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

from rest_framework import viewsets
from rest_framework.permissions import AllowAny
from rest_framework.decorators import action
from rest_framework.response import Response
import requests

from apps.bots.api.serializers import BotConfigSerializer, EmulationTradeSerializer, TradeSerializer
from apps.bots.models import BotConfig, EmulationTrade, Trade

ENGINE_URL = "http://127.0.0.1:3001/engine/bot"

def get_engine_payload(bot):
    keys = {}
    if hasattr(bot.owner, 'exchange_keys'):
        k = bot.owner.exchange_keys
        keys = {
            "binance_api_key": k.binance_api_key,
            "binance_secret": k.binance_secret,
            "bybit_api_key": k.bybit_api_key,
            "bybit_secret": k.bybit_secret,
            "gate_api_key": k.gate_api_key,
            "gate_secret": k.gate_secret,
        }
    return {
        "bot_id": bot.id,
        "config": BotConfigSerializer(bot).data,
        "keys": keys
    }

def sync_with_engine(bot, action="sync"):
    try:
        url = f"{ENGINE_URL}/{action}"
        if action == "force-close" or action == "stop":
            requests.post(url, json={"bot_id": bot.id}, timeout=5)
        else:
            requests.post(url, json=get_engine_payload(bot), timeout=5)
    except requests.RequestException as e:
        print(f"Failed to sync with bot engine: {e}")


class BotConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for bot configurations.

    Users can only access their own bot configurations.
    """

    serializer_class = BotConfigSerializer

    def get_queryset(self) -> BotConfig:
        return BotConfig.objects.filter(owner=self.request.user)

    def perform_create(self, serializer: BotConfigSerializer) -> None:
        bot = serializer.save(owner=self.request.user)
        sync_with_engine(bot, "start")

    def perform_update(self, serializer: BotConfigSerializer) -> None:
        bot = serializer.save()
        if bot.is_active:
            sync_with_engine(bot, "sync")
        else:
            # If deactivated, we could stop but user says "if deactivated current orders finish".
            # The engine handles is_active=false internally via sync to prevent new trades while keeping exit logic.
            sync_with_engine(bot, "sync")

    def perform_destroy(self, instance: BotConfig) -> None:
        sync_with_engine(instance, "stop")
        instance.delete()

    @action(detail=True, methods=["post"], url_path="force-close")
    def force_close(self, request, pk=None):
        bot = self.get_object()
        sync_with_engine(bot, "force-close")
        return Response({"status": "force-close triggered"})


class EmulationTradeViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for emulation trades."""
    
    serializer_class = EmulationTradeSerializer
    permission_classes = [AllowAny]

    def get_queryset(self) -> EmulationTrade:
        qs = EmulationTrade.objects.all()

        if self.request.user.is_authenticated:
            # Authenticated user sees their own bot trades + scanner trades
            from django.db.models import Q
            qs = qs.filter(Q(bot__owner=self.request.user) | Q(bot__isnull=True))
        else:
            # Anonymous (scanner) sees only scanner trades (no bot attached)
            qs = qs.filter(bot__isnull=True)

        # Support status filtering (e.g. ?status=open)
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)

        return qs

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx['user'] = self.request.user
        return ctx


class TradeViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for real arbitrage trades."""

    serializer_class = TradeSerializer
    permission_classes = [AllowAny]

    def get_queryset(self) -> Trade:
        qs = Trade.objects.all()

        # Support status filtering (e.g. ?status=open)
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)

        return qs

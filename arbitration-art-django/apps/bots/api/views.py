from rest_framework import viewsets
from rest_framework.permissions import AllowAny

from apps.bots.api.serializers import BotConfigSerializer, EmulationTradeSerializer
from apps.bots.models import BotConfig, EmulationTrade


class BotConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for bot configurations.

    Users can only access their own bot configurations.
    """

    serializer_class = BotConfigSerializer

    def get_queryset(self) -> BotConfig:
        return BotConfig.objects.filter(owner=self.request.user)

    def perform_create(self, serializer: BotConfigSerializer) -> None:
        serializer.save(owner=self.request.user)


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

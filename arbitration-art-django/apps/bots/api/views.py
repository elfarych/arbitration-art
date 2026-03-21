from rest_framework import viewsets

from apps.bots.api.serializers import BotConfigSerializer
from apps.bots.models import BotConfig


class BotConfigViewSet(viewsets.ModelViewSet):
    """CRUD ViewSet for bot configurations.

    Users can only access their own bot configurations.
    """

    serializer_class = BotConfigSerializer

    def get_queryset(self) -> BotConfig:
        return BotConfig.objects.filter(owner=self.request.user)

    def perform_create(self, serializer: BotConfigSerializer) -> None:
        serializer.save(owner=self.request.user)

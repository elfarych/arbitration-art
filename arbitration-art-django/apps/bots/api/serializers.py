from rest_framework import serializers

from apps.bots.models import BotConfig


class BotConfigSerializer(serializers.ModelSerializer):
    """Serializer for BotConfig CRUD operations."""

    class Meta:
        model = BotConfig
        fields = (
            "id",
            "primary_exchange",
            "secondary_exchange",
            "entry_spread",
            "exit_spread",
            "coin",
            "coin_amount",
            "order_type",
            "max_trades",
            "open_ticks",
            "close_ticks",
            "primary_leverage",
            "secondary_leverage",
            "is_active",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

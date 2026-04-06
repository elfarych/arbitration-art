from rest_framework import serializers

from apps.bots.models import BotConfig, EmulationTrade


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


class EmulationTradeSerializer(serializers.ModelSerializer):
    """Serializer for EmulationTrade CRUD operations."""

    class Meta:
        model = EmulationTrade
        fields = (
            "id",
            "bot",
            "coin",
            "primary_exchange",
            "secondary_exchange",
            "order_type",
            "status",
            "amount",
            "primary_open_price",
            "secondary_open_price",
            "open_spread",
            "primary_close_price",
            "secondary_close_price",
            "close_spread",
            "profit_percentage",
            "opened_at",
            "closed_at",
        )
        read_only_fields = ("id", "opened_at")

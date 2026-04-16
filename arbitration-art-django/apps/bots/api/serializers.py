from rest_framework import serializers

from apps.bots.models import BotConfig, EmulationTrade, Trade


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
            "trade_mode",
            "max_trades",
            "primary_leverage",
            "secondary_leverage",
            "trade_on_primary_exchange",
            "trade_on_secondary_exchange",
            "max_trade_duration_minutes",
            "max_leg_drawdown_percent",
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


class TradeSerializer(serializers.ModelSerializer):
    """Serializer for real Trade CRUD operations."""

    class Meta:
        model = Trade
        fields = (
            "id",
            "coin",
            "primary_exchange",
            "secondary_exchange",
            "order_type",
            "status",
            "close_reason",
            "amount",
            "leverage",
            "primary_open_price",
            "secondary_open_price",
            "primary_open_order_id",
            "secondary_open_order_id",
            "open_spread",
            "open_commission",
            "opened_at",
            "primary_close_price",
            "secondary_close_price",
            "primary_close_order_id",
            "secondary_close_order_id",
            "close_spread",
            "close_commission",
            "profit_usdt",
            "profit_percentage",
            "closed_at",
        )
        read_only_fields = ("id", "opened_at")

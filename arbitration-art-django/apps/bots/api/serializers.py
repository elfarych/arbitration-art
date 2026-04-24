from rest_framework import serializers

from apps.bots.models import (
    BotConfig,
    EmulationTrade,
    Trade,
    TraderRuntimeConfig,
    TraderRuntimeConfigError,
)


class BotConfigSerializer(serializers.ModelSerializer):
    """Serializer for BotConfig CRUD operations."""

    class Meta:
        model = BotConfig
        fields = (
            "id",
            "service_url",
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
            "status",
            "sync_status",
            "last_command",
            "last_sync_error",
            "last_synced_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "status",
            "sync_status",
            "last_command",
            "last_sync_error",
            "last_synced_at",
            "created_at",
            "updated_at",
        )


class TraderRuntimeConfigSerializer(serializers.ModelSerializer):
    """Serializer for standalone trader runtime configuration CRUD."""

    def create(self, validated_data):
        validated_data["is_active"] = False
        return super().create(validated_data)

    class Meta:
        model = TraderRuntimeConfig
        fields = (
            "id",
            "name",
            "service_url",
            "primary_exchange",
            "secondary_exchange",
            "use_testnet",
            "trade_amount_usdt",
            "leverage",
            "max_concurrent_trades",
            "top_liquid_pairs_count",
            "max_trade_duration_minutes",
            "max_leg_drawdown_percent",
            "open_threshold",
            "close_threshold",
            "orderbook_limit",
            "chunk_size",
            "is_active",
            "status",
            "sync_status",
            "last_command",
            "last_sync_error",
            "last_synced_at",
            "is_deleted",
            "archived_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "status",
            "sync_status",
            "last_command",
            "last_sync_error",
            "last_synced_at",
            "is_deleted",
            "archived_at",
            "created_at",
            "updated_at",
        )

    def validate(self, attrs):
        primary_exchange = attrs.get("primary_exchange", getattr(self.instance, "primary_exchange", None))
        secondary_exchange = attrs.get("secondary_exchange", getattr(self.instance, "secondary_exchange", None))

        if primary_exchange == secondary_exchange:
            raise serializers.ValidationError(
                {"secondary_exchange": "Primary and secondary exchanges must be different."}
            )

        return attrs


class TraderRuntimeConfigErrorSerializer(serializers.ModelSerializer):
    """Serializer for runtime errors reported by the standalone trader."""

    class Meta:
        model = TraderRuntimeConfigError
        fields = (
            "id",
            "runtime_config",
            "error_type",
            "error_text",
            "created_at",
        )
        read_only_fields = ("id", "created_at")


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
            "owner",
            "bot",
            "runtime_config",
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
        read_only_fields = ("id", "owner", "opened_at")

    def validate(self, attrs):
        if self.instance is not None:
            return attrs

        bot = attrs.get("bot")
        runtime_config = attrs.get("runtime_config")

        if bool(bot) == bool(runtime_config):
            raise serializers.ValidationError(
                "Trade must be bound to exactly one source: bot or runtime_config."
            )

        return attrs

    def create(self, validated_data):
        bot = validated_data.get("bot")
        runtime_config = validated_data.get("runtime_config")

        if bot is not None:
            validated_data["owner"] = bot.owner
        elif runtime_config is not None:
            validated_data["owner"] = runtime_config.owner
        else:
            raise serializers.ValidationError(
                "Trade must include bot or runtime_config."
            )

        return super().create(validated_data)

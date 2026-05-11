import re

from rest_framework import serializers

from apps.bots.models import (
    BotConfig,
    EmulationTrade,
    Trade,
    TraderRuntimeConfig,
    TraderRuntimeConfigError,
)

# ccxt USDT-margined perpetual symbol pattern used across the engine.
# Example: "BTC/USDT:USDT". Engine looks up market info and websocket
# orderbooks by this exact string; mismatched casing or alternate formats like
# "BTCUSDT" cause the bot to start but never see a tradeable pair.
_COIN_PATTERN = re.compile(r"^[A-Z0-9]{1,20}/USDT:USDT$")

# Mutating these fields while the bot is active is unsafe: the engine's
# in-memory trader was constructed against the prior values (REST clients,
# isolated margin, leverage). Switching them on the fly leaves the runtime in a
# half-configured state and risks real-money mis-execution. The serializer
# requires the operator to first set is_active=False (engine closes positions
# and drops the trader), then change the field, then re-activate.
_RESTRICTED_WHILE_ACTIVE = (
    "trade_mode",
    "primary_exchange",
    "secondary_exchange",
    "primary_leverage",
    "secondary_leverage",
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
            # service_url is owned by the deployment, not the user. Letting the
            # frontend set it would let any authenticated account redirect the
            # lifecycle payload — which carries exchange API keys — to an
            # attacker-controlled host. The deployment chooses the engine URL
            # via settings.BOT_ENGINE_SERVICE_URL_DEFAULT.
            "service_url",
            "status",
            "sync_status",
            "last_command",
            "last_sync_error",
            "last_synced_at",
            "created_at",
            "updated_at",
        )

    def validate_coin(self, value: str) -> str:
        if not _COIN_PATTERN.match(value):
            raise serializers.ValidationError(
                "Coin must be in ccxt USDT-margined futures format, e.g. 'BTC/USDT:USDT'."
            )
        return value

    def validate_coin_amount(self, value):
        if value is None or value <= 0:
            raise serializers.ValidationError("coin_amount must be greater than 0.")
        return value

    def validate(self, attrs):
        instance = self.instance

        primary = attrs.get("primary_exchange", getattr(instance, "primary_exchange", None))
        secondary = attrs.get("secondary_exchange", getattr(instance, "secondary_exchange", None))
        if primary and secondary and primary == secondary:
            raise serializers.ValidationError(
                {"secondary_exchange": "Primary and secondary exchanges must be different."}
            )

        # If the bot will be active and in real mode, at least one leg must
        # actually be executed; otherwise the bot consumes resources without
        # ever opening a trade and confuses operators monitoring it.
        trade_mode = attrs.get("trade_mode", getattr(instance, "trade_mode", BotConfig.TradeMode.EMULATOR))
        is_active = attrs.get("is_active", getattr(instance, "is_active", True))
        trade_on_primary = attrs.get(
            "trade_on_primary_exchange",
            getattr(instance, "trade_on_primary_exchange", True),
        )
        trade_on_secondary = attrs.get(
            "trade_on_secondary_exchange",
            getattr(instance, "trade_on_secondary_exchange", True),
        )
        if (
            is_active
            and trade_mode == BotConfig.TradeMode.REAL
            and not (trade_on_primary or trade_on_secondary)
        ):
            raise serializers.ValidationError(
                "An active real-trading bot must execute on at least one exchange."
            )

        # Block in-place changes to fields that require re-initialising the
        # engine trader. The operator must transition through is_active=False
        # first so the engine cleanly closes positions and rebuilds the trader.
        if instance is not None and instance.is_active and is_active:
            for field in _RESTRICTED_WHILE_ACTIVE:
                if field in attrs and attrs[field] != getattr(instance, field):
                    raise serializers.ValidationError({
                        field: (
                            "Set is_active=false to stop the bot before changing "
                            "this field, then re-activate."
                        ),
                    })

        return attrs


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
        # owner is derived from bot/runtime_config at creation time.
        # opened_at is writable on POST so the engine can record the actual
        # exchange fill timestamp. POST is only available to service-token
        # requests via ServiceTokenWriteOrAuthenticatedRead.
        read_only_fields = ("id", "owner")

    def validate(self, attrs):
        if self.instance is not None:
            # On UPDATE, refuse to rebind the trade to a different source.
            # Rebinding would break ownership boundaries (owner is locked at
            # create) and confuse engine recovery, which queries by bot_id.
            if "bot" in attrs and attrs["bot"] != self.instance.bot:
                raise serializers.ValidationError(
                    {"bot": "Trade source cannot be changed after creation."}
                )
            if "runtime_config" in attrs and attrs["runtime_config"] != self.instance.runtime_config:
                raise serializers.ValidationError(
                    {"runtime_config": "Trade source cannot be changed after creation."}
                )
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

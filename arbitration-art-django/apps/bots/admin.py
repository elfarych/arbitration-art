from django.contrib import admin

from apps.bots.models import (
    BotConfig,
    EmulationTrade,
    Trade,
    TraderRuntimeConfig,
    TraderRuntimeConfigError,
)


@admin.register(BotConfig)
class BotConfigAdmin(admin.ModelAdmin):
    """Admin interface for BotConfig model."""

    list_display = (
        "id",
        "owner",
        "coin",
        "primary_exchange",
        "secondary_exchange",
        "service_url",
        "order_type",
        "is_active",
        "status",
        "sync_status",
        "created_at",
    )
    list_filter = ("is_active", "order_type", "primary_exchange", "status", "sync_status")
    search_fields = ("coin", "owner__email", "service_url")
    readonly_fields = ("status", "sync_status", "last_command", "last_sync_error", "last_synced_at", "created_at", "updated_at")


@admin.register(TraderRuntimeConfig)
class TraderRuntimeConfigAdmin(admin.ModelAdmin):
    """Admin interface for TraderRuntimeConfig model."""

    list_display = (
        "id",
        "owner",
        "name",
        "primary_exchange",
        "secondary_exchange",
        "service_url",
        "is_active",
        "status",
        "sync_status",
        "is_deleted",
        "created_at",
    )
    list_filter = ("is_active", "status", "sync_status", "is_deleted", "use_testnet")
    search_fields = ("name", "owner__email", "service_url")
    readonly_fields = (
        "status",
        "sync_status",
        "last_command",
        "last_sync_error",
        "last_synced_at",
        "archived_at",
        "created_at",
        "updated_at",
    )


@admin.register(TraderRuntimeConfigError)
class TraderRuntimeConfigErrorAdmin(admin.ModelAdmin):
    """Admin interface for TraderRuntimeConfigError model."""

    list_display = (
        "id",
        "runtime_config",
        "error_type",
        "created_at",
    )
    list_filter = ("error_type", "created_at")
    search_fields = ("runtime_config__name", "runtime_config__owner__email", "error_text")
    readonly_fields = ("created_at",)


@admin.register(EmulationTrade)
class EmulationTradeAdmin(admin.ModelAdmin):
    """Admin interface for EmulationTrade model."""

    list_display = (
        "id",
        "bot",
        "status",
        "amount",
        "open_spread",
        "close_spread",
        "profit_percentage",
        "opened_at",
        "closed_at",
    )
    list_filter = ("status", "bot__coin")
    search_fields = ("bot__coin", "status")
    readonly_fields = ("opened_at", "closed_at")


@admin.register(Trade)
class TradeAdmin(admin.ModelAdmin):
    """Admin interface for real Trade model."""

    list_display = (
        "id",
        "owner",
        "bot",
        "runtime_config",
        "coin",
        "order_type",
        "status",
        "close_reason",
        "amount",
        "leverage",
        "open_spread",
        "profit_usdt",
        "profit_percentage",
        "opened_at",
        "closed_at",
    )
    list_filter = ("status", "close_reason", "order_type", "primary_exchange")
    search_fields = ("coin", "owner__email")
    readonly_fields = ("opened_at",)

    fieldsets = (
        (
            None,
            {
                "fields": (
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
                ),
            },
        ),
        (
            "Open Details",
            {
                "fields": (
                    "primary_open_price",
                    "secondary_open_price",
                    "primary_open_order_id",
                    "secondary_open_order_id",
                    "open_spread",
                    "open_commission",
                    "opened_at",
                ),
            },
        ),
        (
            "Close Details",
            {
                "fields": (
                    "primary_close_price",
                    "secondary_close_price",
                    "primary_close_order_id",
                    "secondary_close_order_id",
                    "close_spread",
                    "close_commission",
                    "profit_usdt",
                    "profit_percentage",
                    "closed_at",
                ),
            },
        ),
    )

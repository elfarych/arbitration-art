from django.contrib import admin

from apps.bots.models import BotConfig, EmulationTrade, Trade


@admin.register(BotConfig)
class BotConfigAdmin(admin.ModelAdmin):
    """Admin interface for BotConfig model."""

    list_display = (
        "id",
        "owner",
        "coin",
        "primary_exchange",
        "secondary_exchange",
        "order_type",
        "is_active",
        "created_at",
    )
    list_filter = ("is_active", "order_type", "primary_exchange")
    search_fields = ("coin", "owner__email")
    readonly_fields = ("created_at", "updated_at")

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
    search_fields = ("coin",)
    readonly_fields = ("opened_at",)

    fieldsets = (
        (None, {
            "fields": (
                "coin", "primary_exchange", "secondary_exchange",
                "order_type", "status", "close_reason",
                "amount", "leverage",
            ),
        }),
        ("Open Details", {
            "fields": (
                "primary_open_price", "secondary_open_price",
                "primary_open_order_id", "secondary_open_order_id",
                "open_spread", "open_commission", "opened_at",
            ),
        }),
        ("Close Details", {
            "fields": (
                "primary_close_price", "secondary_close_price",
                "primary_close_order_id", "secondary_close_order_id",
                "close_spread", "close_commission",
                "profit_usdt", "profit_percentage", "closed_at",
            ),
        }),
    )

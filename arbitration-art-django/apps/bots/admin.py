from django.contrib import admin

from apps.bots.models import BotConfig, EmulationTrade


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

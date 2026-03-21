from django.contrib import admin

from apps.bots.models import BotConfig


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

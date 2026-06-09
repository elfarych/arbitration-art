from django.contrib import admin

from apps.levels.models import (
    FavoriteCoin,
    LevelAnalysis,
    LevelAnalysisBreakout,
    LevelNotificationConfig,
    PriceNotification,
)


class LevelAnalysisBreakoutInline(admin.TabularInline):
    model = LevelAnalysisBreakout
    extra = 0
    can_delete = False
    readonly_fields = [field.name for field in LevelAnalysisBreakout._meta.fields]


@admin.register(LevelAnalysis)
class LevelAnalysisAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "owner",
        "symbol",
        "timeframe",
        "breakouts_found",
        "matched",
        "match_rate",
        "created_at",
    )
    list_filter = ("symbol", "timeframe", "direction", "created_at")
    search_fields = ("symbol", "owner__email")
    inlines = [LevelAnalysisBreakoutInline]


@admin.register(FavoriteCoin)
class FavoriteCoinAdmin(admin.ModelAdmin):
    list_display = ("id", "owner", "symbol", "created_at")
    list_filter = ("created_at",)
    search_fields = ("symbol", "owner__email")


@admin.register(LevelNotificationConfig)
class LevelNotificationConfigAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "user",
        "enabled",
        "only_favorites",
        "timeframe",
        "distance_mode",
        "distance_value",
        "updated_at",
    )
    list_filter = ("enabled", "only_favorites", "timeframe", "distance_mode")
    search_fields = ("user__email", "chat_id")


@admin.register(PriceNotification)
class PriceNotificationAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "owner",
        "symbol",
        "target_price",
        "direction",
        "enabled",
        "triggered_at",
        "created_at",
    )
    list_filter = ("enabled", "direction", "created_at")
    search_fields = ("symbol", "owner__email")

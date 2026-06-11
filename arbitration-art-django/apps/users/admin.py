from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)

from apps.users.models import User, UserExchangeKeys, UserSectionAccess

# Hide SimpleJWT token-blacklist tables from Django admin. The app itself
# stays in INSTALLED_APPS because SIMPLE_JWT.BLACKLIST_AFTER_ROTATION relies
# on its models and signal handlers; only the admin surface is removed.
# apps.users sits after rest_framework_simplejwt.token_blacklist in
# INSTALLED_APPS, so the default registrations exist by the time this runs.
admin.site.unregister(BlacklistedToken)
admin.site.unregister(OutstandingToken)


class UserSectionAccessInline(admin.StackedInline):
    """Per-user section toggles, edited inline on the user page.

    extra=1 + max_num=1 shows a single form: the existing row when present, or an
    empty one (all boxes checked from the field defaults) to create it. Leaving
    every box checked keeps the row absent / all-enabled; unchecking disables a
    section for that user.
    """

    model = UserSectionAccess
    can_delete = True
    extra = 1
    min_num = 0
    max_num = 1
    verbose_name_plural = "Доступ к разделам сайта"


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """Admin configuration for the custom User model."""

    list_display = ("email", "username", "is_active", "is_staff", "date_joined")
    list_filter = ("is_active", "is_staff", "is_superuser")
    search_fields = ("email", "username", "first_name", "last_name")
    ordering = ("-date_joined",)
    inlines = (UserSectionAccessInline,)


@admin.register(UserSectionAccess)
class UserSectionAccessAdmin(admin.ModelAdmin):
    """Standalone view of per-user section access (scan/filter restrictions)."""

    list_display = ("user", "bots", "screener", "levels", "pnl")
    list_filter = ("bots", "screener", "levels", "pnl")
    search_fields = ("user__email", "user__username")
    autocomplete_fields = ("user",)


@admin.register(UserExchangeKeys)
class UserExchangeKeysAdmin(admin.ModelAdmin):
    """Admin configuration for exchange API key storage."""

    list_display = (
        "user",
        "has_binance_credentials",
        "has_bybit_credentials",
        "has_gate_credentials",
        "has_mexc_credentials",
    )
    search_fields = ("user__email", "user__username")
    autocomplete_fields = ("user",)

    @admin.display(boolean=True, description="Binance")
    def has_binance_credentials(self, obj: UserExchangeKeys) -> bool:
        return bool(obj.binance_api_key and obj.binance_secret)

    @admin.display(boolean=True, description="Bybit")
    def has_bybit_credentials(self, obj: UserExchangeKeys) -> bool:
        return bool(obj.bybit_api_key and obj.bybit_secret)

    @admin.display(boolean=True, description="Gate")
    def has_gate_credentials(self, obj: UserExchangeKeys) -> bool:
        return bool(obj.gate_api_key and obj.gate_secret)

    @admin.display(boolean=True, description="MEXC")
    def has_mexc_credentials(self, obj: UserExchangeKeys) -> bool:
        return bool(obj.mexc_api_key and obj.mexc_secret)

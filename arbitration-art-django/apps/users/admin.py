from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from apps.users.models import User, UserExchangeKeys


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """Admin configuration for the custom User model."""

    list_display = ("email", "username", "is_active", "is_staff", "date_joined")
    list_filter = ("is_active", "is_staff", "is_superuser")
    search_fields = ("email", "username", "first_name", "last_name")
    ordering = ("-date_joined",)


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

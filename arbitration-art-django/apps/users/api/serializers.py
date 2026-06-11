from rest_framework import serializers

from apps.users.models import User, UserExchangeKeys, UserSectionAccess

EXCHANGE_KEY_FIELDS = (
    "binance_api_key",
    "binance_secret",
    "bybit_api_key",
    "bybit_secret",
    "gate_api_key",
    "gate_secret",
    "mexc_api_key",
    "mexc_secret",
)


class UserSerializer(serializers.ModelSerializer):
    """Serializer for current user profile data."""

    # Per-user section access map ({bots, screener, levels, pnl} -> bool). Drives
    # the frontend menu/route gate. Users with no UserSectionAccess row get all
    # sections enabled (the default). Keep keys in sync with the frontend
    # SectionKey type and router meta (AGENTS.md §9).
    sections = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "email", "username", "first_name", "last_name", "date_joined", "sections")
        # `sections` is a SerializerMethodField (inherently read-only) and must not
        # be listed here, so read_only_fields covers only the model fields.
        read_only_fields = ("id", "email", "username", "first_name", "last_name", "date_joined")

    def get_sections(self, obj: User) -> dict[str, bool]:
        access = getattr(obj, "section_access", None)
        return access.as_dict() if access else UserSectionAccess.default_dict()


class UserExchangeKeysSerializer(serializers.ModelSerializer):
    """Serializer for managing current user's exchange API keys."""

    class Meta:
        model = UserExchangeKeys
        fields = EXCHANGE_KEY_FIELDS
        extra_kwargs = {field: {"write_only": True, "required": False, "allow_blank": True} for field in EXCHANGE_KEY_FIELDS}

    def to_representation(self, instance: UserExchangeKeys) -> dict[str, dict[str, str | bool]]:
        return {
            "binance": self._exchange_state(instance.binance_api_key, instance.binance_secret),
            "bybit": self._exchange_state(instance.bybit_api_key, instance.bybit_secret),
            "gate": self._exchange_state(instance.gate_api_key, instance.gate_secret),
            "mexc": self._exchange_state(instance.mexc_api_key, instance.mexc_secret),
        }

    def update(self, instance: UserExchangeKeys, validated_data):
        if not validated_data:
            return instance

        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save(update_fields=[*validated_data.keys()])
        return instance

    def _exchange_state(self, api_key: str, secret: str) -> dict[str, str | bool]:
        return {
            "has_api_key": bool(api_key),
            "has_secret": bool(secret),
            "api_key_preview": self._mask(api_key),
            "secret_preview": self._mask(secret),
        }

    def _mask(self, value: str) -> str:
        if not value:
            return ""
        if len(value) <= 8:
            return "*" * len(value)
        return f"{value[:4]}...{value[-4:]}"

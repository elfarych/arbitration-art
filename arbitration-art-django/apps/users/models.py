from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Custom user model with email as the primary login field."""

    email = models.EmailField(
        "email address",
        unique=True,
        error_messages={
            "unique": "A user with that email already exists.",
        },
    )

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["username"]

    class Meta:
        verbose_name = "user"
        verbose_name_plural = "users"
        ordering = ["-date_joined"]

    def __str__(self) -> str:
        return self.email

class UserSectionAccess(models.Model):
    """Per-user access toggles for the top-level site sections.

    Frontend gate only: the SPA reads these flags from /auth/me/ and hides the
    menu item + blocks the route for disabled sections. The absence of a row means
    every section is enabled (the default for all users), so restricting a user is
    opt-in via the admin. Profile and trader-runtime are always available and are
    intentionally not represented here.

    SECTIONS keys mirror the frontend router `meta.section` values and the auth
    store `SectionKey` type — keep all three in sync (see AGENTS.md §9).
    """

    SECTIONS = ("bots", "screener", "levels", "pnl")

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="section_access"
    )
    bots = models.BooleanField("Боты (/)", default=True)
    screener = models.BooleanField("Скринер (/screener)", default=True)
    levels = models.BooleanField("Уровни (/levels)", default=True)
    pnl = models.BooleanField("PnL (/pnl)", default=True)

    class Meta:
        verbose_name = "user section access"
        verbose_name_plural = "user section access"

    def __str__(self) -> str:
        return f"{self.user.email} section access"

    def as_dict(self) -> dict[str, bool]:
        return {section: getattr(self, section) for section in self.SECTIONS}

    @classmethod
    def default_dict(cls) -> dict[str, bool]:
        """Access map for a user with no row — everything enabled."""
        return {section: True for section in cls.SECTIONS}


class UserExchangeKeys(models.Model):
    """Secure storage for user exchange API keys."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="exchange_keys")
    binance_api_key = models.CharField(max_length=255, blank=True)
    binance_secret = models.CharField(max_length=255, blank=True)
    bybit_api_key = models.CharField(max_length=255, blank=True)
    bybit_secret = models.CharField(max_length=255, blank=True)
    gate_api_key = models.CharField(max_length=255, blank=True)
    gate_secret = models.CharField(max_length=255, blank=True)
    mexc_api_key = models.CharField(max_length=255, blank=True)
    mexc_secret = models.CharField(max_length=255, blank=True)

    class Meta:
        verbose_name = "user exchange keys"
        verbose_name_plural = "user exchange keys"

    def __str__(self) -> str:
        return f"{self.user.email} exchange keys"

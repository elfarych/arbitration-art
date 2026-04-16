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

class UserExchangeKeys(models.Model):
    """Secure storage for user exchange API keys."""
    
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="exchange_keys")
    binance_api_key = models.CharField(max_length=255, blank=True)
    binance_secret = models.CharField(max_length=255, blank=True)
    bybit_api_key = models.CharField(max_length=255, blank=True)
    bybit_secret = models.CharField(max_length=255, blank=True)
    gate_api_key = models.CharField(max_length=255, blank=True)
    gate_secret = models.CharField(max_length=255, blank=True)

    class Meta:
        verbose_name = "user exchange keys"
        verbose_name_plural = "user exchange keys"

    def __str__(self) -> str:
        return f"{self.user.email} exchange keys"

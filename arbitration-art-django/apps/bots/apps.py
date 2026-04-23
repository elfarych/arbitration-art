from django.apps import AppConfig


class BotsConfig(AppConfig):
    """Configuration for the bots application."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.bots"
    verbose_name = "Bot Configurations"

    def ready(self) -> None:
        """Register signal handlers for lifecycle synchronization."""

        import apps.bots.signals  # noqa: F401

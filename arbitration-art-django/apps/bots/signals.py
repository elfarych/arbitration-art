from django.db import transaction
from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver

from apps.bots.models import BotConfig, LifecycleCommand, TraderRuntimeConfig
from apps.bots.services.lifecycle import (
    LifecycleSyncError,
    stop_deleted_bot,
    sync_trader_runtime_lifecycle,
)


def _run_safely(callback, *args) -> None:
    """Execute lifecycle sync callbacks without breaking the original save."""

    try:
        callback(*args)
    except LifecycleSyncError:
        pass


@receiver(pre_delete, sender=BotConfig)
def bot_config_pre_delete(sender, instance: BotConfig, **kwargs) -> None:
    """Best-effort engine stop for BotConfig deletions outside the API.

    The primary delete path is BotConfigViewSet.destroy, which calls
    sync_bot_lifecycle('stop') inline and returns 502 on failure. This signal
    only fires for admin deletions, cascade deletes (user removal), and any
    other code path that bypasses the API view. Errors here are swallowed
    because failing a cascade delete would leave Django in an inconsistent
    half-deleted state — the API path remains the safe one to rely on.
    """

    if not instance.is_active:
        return

    service_url = instance.service_url
    bot_id = instance.pk
    transaction.on_commit(lambda: _run_safely(stop_deleted_bot, service_url, bot_id))


@receiver(post_save, sender=TraderRuntimeConfig)
def trader_runtime_config_post_save(
    sender,
    instance: TraderRuntimeConfig,
    created: bool,
    **kwargs,
) -> None:
    """Synchronize standalone trader lifecycle after model commits."""

    if created and not instance.is_active and not instance.is_deleted:
        return

    if instance.is_deleted or not instance.is_active:
        action = LifecycleCommand.STOP
    elif created:
        action = LifecycleCommand.START
    else:
        action = LifecycleCommand.SYNC

    transaction.on_commit(
        lambda: _run_safely(sync_trader_runtime_lifecycle, instance.pk, action)
    )

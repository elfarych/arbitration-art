from django.db import transaction
from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver

from apps.bots.models import BotConfig, LifecycleCommand, TraderRuntimeConfig
from apps.bots.services.lifecycle import (
    LifecycleSyncError,
    stop_deleted_bot,
    sync_bot_lifecycle,
    sync_trader_runtime_lifecycle,
)


def _run_safely(callback, *args) -> None:
    """Execute lifecycle sync callbacks without breaking the original save."""

    try:
        callback(*args)
    except LifecycleSyncError:
        pass


@receiver(post_save, sender=BotConfig)
def bot_config_post_save(sender, instance: BotConfig, created: bool, **kwargs) -> None:
    """Synchronize bot runtime lifecycle after BotConfig commits."""

    action = LifecycleCommand.START if created else LifecycleCommand.SYNC
    if not created and not instance.is_active:
        action = LifecycleCommand.STOP

    transaction.on_commit(lambda: _run_safely(sync_bot_lifecycle, instance.pk, action))


@receiver(pre_delete, sender=BotConfig)
def bot_config_pre_delete(sender, instance: BotConfig, **kwargs) -> None:
    """Gracefully stop external runtime before BotConfig is physically deleted."""

    transaction.on_commit(
        lambda: _run_safely(stop_deleted_bot, instance.service_url, instance.pk)
    )


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

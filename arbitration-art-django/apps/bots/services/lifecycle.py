import time
from typing import Any

import requests
from django.utils import timezone

from apps.bots.models import (
    BotConfig,
    LifecycleCommand,
    RuntimeStatus,
    SyncStatus,
    TraderRuntimeConfig,
)
from apps.bots.services.trader_runtime_shared import (
    build_trader_runtime_payload,
    exchange_keys_for_user,
    join_control_url,
    request_settings,
    service_headers,
)


class LifecycleSyncError(RuntimeError):
    """Raised when Django cannot synchronize lifecycle state with a runtime."""


def _perform_post(url: str, payload: dict[str, Any]) -> None:
    retries, timeout, retry_delay = request_settings()
    last_error = "Unknown service sync error."
    try:
        headers = service_headers()
    except RuntimeError as exc:
        raise LifecycleSyncError(str(exc)) from exc

    for attempt in range(1, retries + 1):
        try:
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=timeout,
            )
            response.raise_for_status()
            return
        except requests.RequestException as exc:
            response_text = ""
            if exc.response is not None and exc.response.text:
                response_text = exc.response.text.strip()[:500]

            last_error = response_text or str(exc)
            if attempt < retries:
                time.sleep(retry_delay)

    raise LifecycleSyncError(last_error)


def _bot_runtime_payload(bot: BotConfig) -> dict[str, Any]:
    return {
        "bot_id": bot.id,
        "owner_id": bot.owner_id,
        "config": {
            "id": bot.id,
            "primary_exchange": bot.primary_exchange,
            "secondary_exchange": bot.secondary_exchange,
            "entry_spread": str(bot.entry_spread),
            "exit_spread": str(bot.exit_spread),
            "coin": bot.coin,
            "coin_amount": str(bot.coin_amount),
            "order_type": bot.order_type,
            "trade_mode": bot.trade_mode,
            "max_trades": bot.max_trades,
            "primary_leverage": bot.primary_leverage,
            "secondary_leverage": bot.secondary_leverage,
            "trade_on_primary_exchange": bot.trade_on_primary_exchange,
            "trade_on_secondary_exchange": bot.trade_on_secondary_exchange,
            "max_trade_duration_minutes": bot.max_trade_duration_minutes,
            "max_leg_drawdown_percent": bot.max_leg_drawdown_percent,
            "is_active": bot.is_active,
        },
        "keys": exchange_keys_for_user(bot.owner),
    }


def _pending_status_for(action: str) -> str:
    if action in {LifecycleCommand.START, LifecycleCommand.SYNC}:
        return RuntimeStatus.STARTING
    if action == LifecycleCommand.STOP:
        return RuntimeStatus.STOPPING
    return ""


def _success_status_for(action: str, *, archived: bool) -> str:
    if archived:
        return RuntimeStatus.ARCHIVED
    if action in {LifecycleCommand.START, LifecycleCommand.SYNC}:
        return RuntimeStatus.RUNNING
    if action == LifecycleCommand.STOP:
        return RuntimeStatus.STOPPED
    return ""


def _update_sync_metadata(queryset, *, action: str, sync_status: str, error: str = "", status: str | None = None) -> None:
    update_data: dict[str, Any] = {
        "last_command": action,
        "sync_status": sync_status,
        "last_sync_error": error,
    }

    if sync_status in {SyncStatus.SUCCESS, SyncStatus.FAILED}:
        update_data["last_synced_at"] = timezone.now()

    if status:
        update_data["status"] = status

    queryset.update(**update_data)


def sync_bot_lifecycle(bot_id: int, action: str) -> None:
    """Synchronize a BotConfig lifecycle change with its remote service."""

    bot = (
        BotConfig.objects.select_related("owner", "owner__exchange_keys")
        .filter(pk=bot_id)
        .first()
    )
    if bot is None:
        raise LifecycleSyncError(f"BotConfig {bot_id} does not exist.")

    _update_sync_metadata(
        BotConfig.objects.filter(pk=bot_id),
        action=action,
        sync_status=SyncStatus.PENDING,
        status=_pending_status_for(action),
    )

    path = f"/engine/bot/{action}"
    payload = {"bot_id": bot.id} if action in {LifecycleCommand.STOP, LifecycleCommand.FORCE_CLOSE} else _bot_runtime_payload(bot)

    try:
        _perform_post(join_control_url(bot.service_url, path), payload)
    except LifecycleSyncError as exc:
        _update_sync_metadata(
            BotConfig.objects.filter(pk=bot_id),
            action=action,
            sync_status=SyncStatus.FAILED,
            error=str(exc),
            status=RuntimeStatus.ERROR,
        )
        raise

    status = _success_status_for(action, archived=False)
    _update_sync_metadata(
        BotConfig.objects.filter(pk=bot_id),
        action=action,
        sync_status=SyncStatus.SUCCESS,
        status=status or None,
    )


def stop_deleted_bot(service_url: str, bot_id: int) -> None:
    """Send a best-effort stop command for a BotConfig being deleted."""

    _perform_post(
        join_control_url(service_url, "/engine/bot/stop"),
        {"bot_id": bot_id},
    )


def sync_trader_runtime_lifecycle(runtime_config_id: int, action: str) -> None:
    """Synchronize a TraderRuntimeConfig lifecycle change with its remote service."""

    runtime_config = (
        TraderRuntimeConfig.objects.select_related("owner", "owner__exchange_keys")
        .filter(pk=runtime_config_id)
        .first()
    )
    if runtime_config is None:
        raise LifecycleSyncError(
            f"TraderRuntimeConfig {runtime_config_id} does not exist."
        )

    _update_sync_metadata(
        TraderRuntimeConfig.objects.filter(pk=runtime_config_id),
        action=action,
        sync_status=SyncStatus.PENDING,
        status=_pending_status_for(action),
    )

    path = f"/engine/trader/{action}"
    payload = (
        {"runtime_config_id": runtime_config.id}
        if action == LifecycleCommand.STOP
        else build_trader_runtime_payload(runtime_config)
    )

    try:
        _perform_post(join_control_url(runtime_config.service_url, path), payload)
    except LifecycleSyncError as exc:
        _update_sync_metadata(
            TraderRuntimeConfig.objects.filter(pk=runtime_config_id),
            action=action,
            sync_status=SyncStatus.FAILED,
            error=str(exc),
            status=RuntimeStatus.ERROR,
        )
        raise

    _update_sync_metadata(
        TraderRuntimeConfig.objects.filter(pk=runtime_config_id),
        action=action,
        sync_status=SyncStatus.SUCCESS,
        status=_success_status_for(action, archived=runtime_config.is_deleted),
    )

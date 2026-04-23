import time
from typing import Any

import requests
from django.conf import settings
from django.utils import timezone

from apps.bots.models import (
    BotConfig,
    LifecycleCommand,
    RuntimeStatus,
    SyncStatus,
    TraderRuntimeConfig,
)


class LifecycleSyncError(RuntimeError):
    """Raised when Django cannot synchronize lifecycle state with a runtime."""


def _join_control_url(service_url: str, path: str) -> str:
    return f"{service_url.rstrip('/')}/{path.lstrip('/')}"


def _service_headers() -> dict[str, str]:
    token = getattr(settings, "SERVICE_SHARED_TOKEN", "")
    if not token:
        raise LifecycleSyncError("SERVICE_SHARED_TOKEN is not configured.")

    return {
        "Content-Type": "application/json",
        "X-Service-Token": token,
    }


def _request_settings() -> tuple[int, float, float]:
    retries = max(1, int(getattr(settings, "SERVICE_REQUEST_RETRIES", 3)))
    timeout = float(getattr(settings, "SERVICE_REQUEST_TIMEOUT_SECONDS", 5))
    retry_delay = float(getattr(settings, "SERVICE_REQUEST_RETRY_DELAY_SECONDS", 1))
    return retries, timeout, retry_delay


def _perform_post(url: str, payload: dict[str, Any]) -> None:
    retries, timeout, retry_delay = _request_settings()
    last_error = "Unknown service sync error."

    for attempt in range(1, retries + 1):
        try:
            response = requests.post(
                url,
                json=payload,
                headers=_service_headers(),
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


def _exchange_keys_for_user(user) -> dict[str, str]:
    keys = getattr(user, "exchange_keys", None)
    if keys is None:
        return {}

    return {
        "binance_api_key": keys.binance_api_key,
        "binance_secret": keys.binance_secret,
        "bybit_api_key": keys.bybit_api_key,
        "bybit_secret": keys.bybit_secret,
        "gate_api_key": keys.gate_api_key,
        "gate_secret": keys.gate_secret,
        "mexc_api_key": keys.mexc_api_key,
        "mexc_secret": keys.mexc_secret,
    }


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
        "keys": _exchange_keys_for_user(bot.owner),
    }


def _trader_runtime_payload(runtime_config: TraderRuntimeConfig) -> dict[str, Any]:
    return {
        "runtime_config_id": runtime_config.id,
        "owner_id": runtime_config.owner_id,
        "config": {
            "id": runtime_config.id,
            "name": runtime_config.name,
            "primary_exchange": runtime_config.primary_exchange,
            "secondary_exchange": runtime_config.secondary_exchange,
            "use_testnet": runtime_config.use_testnet,
            "trade_amount_usdt": str(runtime_config.trade_amount_usdt),
            "leverage": runtime_config.leverage,
            "max_concurrent_trades": runtime_config.max_concurrent_trades,
            "top_liquid_pairs_count": runtime_config.top_liquid_pairs_count,
            "max_trade_duration_minutes": runtime_config.max_trade_duration_minutes,
            "max_leg_drawdown_percent": str(runtime_config.max_leg_drawdown_percent),
            "open_threshold": str(runtime_config.open_threshold),
            "close_threshold": str(runtime_config.close_threshold),
            "orderbook_limit": runtime_config.orderbook_limit,
            "chunk_size": runtime_config.chunk_size,
            "is_active": runtime_config.is_active,
        },
        "keys": _exchange_keys_for_user(runtime_config.owner),
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
        _perform_post(_join_control_url(bot.service_url, path), payload)
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
        _join_control_url(service_url, "/engine/bot/stop"),
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
        else _trader_runtime_payload(runtime_config)
    )

    try:
        _perform_post(_join_control_url(runtime_config.service_url, path), payload)
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

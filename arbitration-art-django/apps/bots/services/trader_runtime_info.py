import time
from typing import Any

import requests

from apps.bots.models import TraderRuntimeConfig
from apps.bots.services.trader_runtime_shared import (
    build_trader_runtime_payload,
    join_control_url,
    request_settings,
    service_headers,
)


class TraderRuntimeInfoError(RuntimeError):
    """Raised when Django cannot fetch runtime diagnostics from arbitration-trader."""


def _perform_request(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> Any:
    retries, timeout, retry_delay = request_settings()
    last_error = "Unknown trader runtime info error."
    try:
        headers = service_headers()
    except RuntimeError as exc:
        raise TraderRuntimeInfoError(str(exc)) from exc

    for attempt in range(1, retries + 1):
        try:
            response = requests.request(
                method=method,
                url=url,
                json=payload,
                params=params,
                headers=headers,
                timeout=timeout,
            )
            response.raise_for_status()

            if not response.content:
                return {}

            return response.json()
        except requests.RequestException as exc:
            response_text = ""
            if exc.response is not None and exc.response.text:
                response_text = exc.response.text.strip()[:500]

            last_error = response_text or str(exc)
            if attempt < retries:
                time.sleep(retry_delay)

    raise TraderRuntimeInfoError(last_error)


def _get_runtime_config(runtime_config_id: int) -> TraderRuntimeConfig:
    runtime_config = (
        TraderRuntimeConfig.objects.select_related("owner", "owner__exchange_keys")
        .filter(pk=runtime_config_id, is_deleted=False)
        .first()
    )
    if runtime_config is None:
        raise TraderRuntimeInfoError(
            f"TraderRuntimeConfig {runtime_config_id} does not exist."
        )

    return runtime_config


def fetch_trader_runtime_exchange_health(runtime_config_id: int) -> Any:
    runtime_config = _get_runtime_config(runtime_config_id)
    return _perform_request(
        "POST",
        join_control_url(
            runtime_config.service_url,
            "/engine/trader/runtime/exchange-health",
        ),
        payload=build_trader_runtime_payload(runtime_config),
    )


def fetch_trader_runtime_active_coins(runtime_config_id: int) -> Any:
    runtime_config = _get_runtime_config(runtime_config_id)
    return _perform_request(
        "GET",
        join_control_url(
            runtime_config.service_url,
            "/engine/trader/runtime/active-coins",
        ),
        params={"runtime_config_id": runtime_config.id},
    )


def fetch_trader_runtime_open_trades_pnl(runtime_config_id: int) -> Any:
    runtime_config = _get_runtime_config(runtime_config_id)
    return _perform_request(
        "GET",
        join_control_url(
            runtime_config.service_url,
            "/engine/trader/runtime/open-trades-pnl",
        ),
        params={"runtime_config_id": runtime_config.id},
    )


def fetch_trader_runtime_system_load(runtime_config_id: int) -> Any:
    runtime_config = _get_runtime_config(runtime_config_id)
    return _perform_request(
        "GET",
        join_control_url(
            runtime_config.service_url,
            "/engine/trader/runtime/system-load",
        ),
        params={"runtime_config_id": runtime_config.id},
    )

"""Profile-level exchange key tests proxied to the bot engine.

The actual exchange calls are executed inside ``arbitration-bot-engine`` so
that key validation reuses the exact code path that the engine uses when
running a live bot. Django only forwards user-scoped credentials and the
requested operation; the engine returns the structured probe result.

Two helpers are exposed:

- :func:`request_test_connection` performs a read-only probe.
- :func:`request_test_trade` performs a round-trip SOL/USDT futures trade
  with $15 margin and 10x leverage and measures per-leg latency in ms.
"""

from typing import Any

import requests
from django.conf import settings

from apps.bots.services.trader_runtime_shared import (
    join_control_url,
    request_settings,
    service_headers,
)
from apps.users.models import UserExchangeKeys

SUPPORTED_EXCHANGES: tuple[str, ...] = ("binance", "bybit", "gate", "mexc")

# Engine performs an open + close round-trip and may briefly retry order
# polling. 30s gives the slowest paths (Gate, MEXC) enough headroom while
# still failing fast if the engine itself is unreachable.
TEST_TRADE_TIMEOUT_SECONDS = 30
TEST_CONNECTION_TIMEOUT_SECONDS = 15


class ExchangeTestError(RuntimeError):
    """Raised when the engine cannot run an exchange-key probe."""


class ExchangeKeysMissing(ExchangeTestError):
    """API key or secret is empty in ``UserExchangeKeys``."""


def _credentials(keys: UserExchangeKeys, exchange: str) -> tuple[str, str]:
    api_key = (getattr(keys, f"{exchange}_api_key", "") or "").strip()
    secret = (getattr(keys, f"{exchange}_secret", "") or "").strip()
    if not api_key or not secret:
        raise ExchangeKeysMissing(
            f"API key or secret for {exchange} is not configured."
        )
    return api_key, secret


def _engine_url(path: str) -> str:
    base = getattr(settings, "BOT_ENGINE_SERVICE_URL_DEFAULT", "")
    if not base:
        raise ExchangeTestError("BOT_ENGINE_SERVICE_URL_DEFAULT is not configured.")
    return join_control_url(base, path)


def _post(path: str, payload: dict[str, Any], *, timeout: float) -> Any:
    retries, _, retry_delay = request_settings()
    try:
        headers = service_headers()
    except RuntimeError as exc:
        raise ExchangeTestError(str(exc)) from exc

    url = _engine_url(path)
    last_error = "Unknown engine probe error."

    for attempt in range(1, retries + 1):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=timeout)
            response.raise_for_status()
            if not response.content:
                return {}
            return response.json()
        except requests.RequestException as exc:
            response_text = ""
            if exc.response is not None and exc.response.text:
                response_text = exc.response.text.strip()[:500]
            last_error = response_text or str(exc)
            # Retrying a real-money trade is dangerous: the previous attempt
            # may have placed an order even if Django saw a network failure.
            # Only retry the read-only test-connection probe.
            if attempt < retries and path.endswith("/test-connection"):
                import time

                time.sleep(retry_delay)
                continue
            break

    raise ExchangeTestError(last_error)


def request_test_connection(keys: UserExchangeKeys, exchange: str) -> dict[str, Any]:
    api_key, secret = _credentials(keys, exchange)
    return _post(
        "/engine/exchange/test-connection",
        {"exchange": exchange, "api_key": api_key, "secret": secret},
        timeout=TEST_CONNECTION_TIMEOUT_SECONDS,
    )


def request_test_trade(keys: UserExchangeKeys, exchange: str) -> dict[str, Any]:
    api_key, secret = _credentials(keys, exchange)
    return _post(
        "/engine/exchange/test-trade",
        {"exchange": exchange, "api_key": api_key, "secret": secret},
        timeout=TEST_TRADE_TIMEOUT_SECONDS,
    )

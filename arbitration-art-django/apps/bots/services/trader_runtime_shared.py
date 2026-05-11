from typing import Any

from django.conf import settings

from apps.bots.models import TraderRuntimeConfig


def join_control_url(service_url: str, path: str) -> str:
    return f"{service_url.rstrip('/')}/{path.lstrip('/')}"


def service_headers() -> dict[str, str]:
    token = getattr(settings, "SERVICE_SHARED_TOKEN", "")
    if not token:
        raise RuntimeError("SERVICE_SHARED_TOKEN is not configured.")

    return {
        "Content-Type": "application/json",
        "X-Service-Token": token,
    }


def request_settings() -> tuple[int, float, float]:
    retries = max(1, int(getattr(settings, "SERVICE_REQUEST_RETRIES", 3)))
    timeout = float(getattr(settings, "SERVICE_REQUEST_TIMEOUT_SECONDS", 5))
    retry_delay = float(getattr(settings, "SERVICE_REQUEST_RETRY_DELAY_SECONDS", 1))
    return retries, timeout, retry_delay


def exchange_keys_for_user(user, exchanges: tuple[str, ...] | None = None) -> dict[str, str]:
    """Return the subset of API credentials needed for the given exchanges.

    Sending every user's full key set on every lifecycle command unnecessarily
    enlarges the surface for credential leakage (engine logs, intermediate
    proxies, error reports). When the caller specifies which exchanges the
    runtime actually needs, only those pairs are emitted. The exchange names
    must match the prefixes used by Engine.extractKeys
    (``binance``/``bybit``/``gate``/``mexc``); both bot-style names
    ("binance_futures") and short names ("binance") are accepted.
    """

    keys = getattr(user, "exchange_keys", None)
    if keys is None:
        return {}

    sources = {
        "binance": ("binance_api_key", "binance_secret"),
        "bybit": ("bybit_api_key", "bybit_secret"),
        "gate": ("gate_api_key", "gate_secret"),
        "mexc": ("mexc_api_key", "mexc_secret"),
    }

    if exchanges is None:
        wanted = set(sources.keys())
    else:
        wanted = set()
        for name in exchanges:
            if not name:
                continue
            prefix = name.split("_", 1)[0].lower()
            if prefix in sources:
                wanted.add(prefix)

    result: dict[str, str] = {}
    for prefix in wanted:
        api_key_field, secret_field = sources[prefix]
        result[api_key_field] = getattr(keys, api_key_field, "")
        result[secret_field] = getattr(keys, secret_field, "")
    return result


def build_trader_runtime_payload(runtime_config: TraderRuntimeConfig) -> dict[str, Any]:
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
        "keys": exchange_keys_for_user(runtime_config.owner),
    }

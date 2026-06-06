from typing import Any

import requests
from django.conf import settings


class LevelsAnalysisError(RuntimeError):
    """Raised when Django cannot obtain a breakout analysis from levels-api."""


def run_analysis(symbol: str, timeframe: str, query: dict[str, Any]) -> dict[str, Any]:
    """Call levels-api `GET /analysis/:tf/:symbol` and return the parsed result.

    Single request, no retries: the analysis is expensive (fetches candles +
    trades from Binance) and a long timeout retried 3× would block a worker for
    minutes. The caller (viewset) maps `LevelsAnalysisError` to a 502.
    """
    base = settings.LEVELS_API_URL.rstrip("/")
    url = f"{base}/analysis/{timeframe}/{symbol.upper()}"
    timeout = float(getattr(settings, "LEVELS_API_REQUEST_TIMEOUT_SECONDS", 120))
    try:
        response = requests.get(url, params=query, timeout=timeout)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        text = ""
        if exc.response is not None and exc.response.text:
            text = exc.response.text.strip()[:500]
        raise LevelsAnalysisError(text or str(exc)) from exc

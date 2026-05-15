"""PnL aggregation across real Trade and EmulationTrade rows.

The endpoint reuses the same data the engine writes through
`api.openTrade` / `api.openEmulationTrade` + close PATCH-es. Real trades carry
the authoritative `profit_usdt` produced by `calculateRealPnL` in the engine;
emulation trades only persist `profit_percentage`, so this module recomputes
their notional from `amount * min(open_price)` (matching the engine's
`capital = amount * Math.min(openPrimary, openSecondary)` in
`arbitration-bot-engine/src/utils/math.ts::calculateRealPnL`).

Aggregation runs on demand against Postgres; with the existing indexes on
`closed_at` and `bot_id` this is cheap enough for interactive UI usage.
Caching is intentionally not added — engine writes flow into Django the moment
trades close, so a stale cache would defeat the "today PnL in the header" UX.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Iterable

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, QuerySet, Sum
from django.db.models.functions import Coalesce, Least

from apps.bots.models import BotConfig, EmulationTrade, Trade


# Trade rows are considered final only after the engine writes `closed_at`.
# Status filter excludes the small window where a closed-but-still-being-
# patched trade exists: the engine first PATCH-es status, then profit fields,
# so we additionally require profit_usdt / profit_percentage to be non-null.
_REAL_FINAL_STATUSES = (Trade.Status.CLOSED, Trade.Status.FORCE_CLOSED)
_EMU_FINAL_STATUSES = (EmulationTrade.Status.CLOSED,)


@dataclass(frozen=True)
class PnlFilters:
    """Query parameters validated by the view layer."""

    user_id: int
    date_from: datetime | None
    date_to: datetime | None
    bot_id: int | None
    # None -> include both modes
    trade_mode: str | None  # "real" | "emulator"


def _zero() -> Decimal:
    return Decimal("0")


def _apply_window(qs: QuerySet, filters: PnlFilters) -> QuerySet:
    """Filter the queryset by closed_at window and optional bot_id."""
    qs = qs.exclude(closed_at__isnull=True)
    if filters.date_from is not None:
        qs = qs.filter(closed_at__gte=filters.date_from)
    if filters.date_to is not None:
        qs = qs.filter(closed_at__lte=filters.date_to)
    if filters.bot_id is not None:
        qs = qs.filter(bot_id=filters.bot_id)
    return qs


def _real_queryset(filters: PnlFilters) -> QuerySet:
    qs = Trade.objects.filter(
        owner_id=filters.user_id,
        status__in=_REAL_FINAL_STATUSES,
        profit_usdt__isnull=False,
    )
    return _apply_window(qs, filters)


def _emulation_queryset(filters: PnlFilters) -> QuerySet:
    qs = EmulationTrade.objects.filter(
        bot__owner_id=filters.user_id,
        status__in=_EMU_FINAL_STATUSES,
        profit_percentage__isnull=False,
    )
    return _apply_window(qs, filters)


# Derived USDT profit for emulation trades. EmulationTrade stores only
# profit_percentage because the engine does not pay commission for paper
# trades; the percentage was computed against `capital = amount × min(open
# prices)` in `calculateRealPnL` (arbitration-bot-engine/src/utils/math.ts),
# so the inverse here gives the same USDT figure the engine logged at close.
_EMU_USDT_DECIMAL = DecimalField(max_digits=30, decimal_places=10)
_EMU_USDT_EXPR = ExpressionWrapper(
    F("profit_percentage")
    * F("amount")
    * Least(F("primary_open_price"), F("secondary_open_price"))
    / Decimal("100"),
    output_field=_EMU_USDT_DECIMAL,
)


def _aggregate_real(filters: PnlFilters) -> dict:
    """Aggregate authoritative real-trade PnL in USDT.

    Result keys are intentionally renamed (`sum_profit_usdt` etc.) so they do
    not collide with the `profit_usdt` model field: Django would otherwise
    reject a filter like `Q(profit_usdt__gt=0)` evaluated alongside the
    aggregate, complaining that `profit_usdt` is an aggregate, not a column.
    """
    qs = _real_queryset(filters)
    agg = qs.aggregate(
        sum_profit_usdt=Coalesce(Sum("profit_usdt"), _zero()),
        cnt_total=Count("id"),
        cnt_wins=Count("id", filter=Q(profit_usdt__gt=0)),
        cnt_losses=Count("id", filter=Q(profit_usdt__lt=0)),
    )
    return {
        "profit_usdt": agg["sum_profit_usdt"],
        "trades_count": agg["cnt_total"],
        "wins": agg["cnt_wins"],
        "losses": agg["cnt_losses"],
    }


def _aggregate_emulation(filters: PnlFilters) -> dict:
    """Aggregate emulation PnL — USDT is derived from percentage × notional."""
    qs = _emulation_queryset(filters).annotate(_derived_usdt=_EMU_USDT_EXPR)
    agg = qs.aggregate(
        sum_profit_usdt=Coalesce(
            Sum("_derived_usdt"),
            _zero(),
            output_field=DecimalField(max_digits=30, decimal_places=10),
        ),
        cnt_total=Count("id"),
        cnt_wins=Count("id", filter=Q(profit_percentage__gt=0)),
        cnt_losses=Count("id", filter=Q(profit_percentage__lt=0)),
    )
    return {
        "profit_usdt": agg["sum_profit_usdt"],
        "trades_count": agg["cnt_total"],
        "wins": agg["cnt_wins"],
        "losses": agg["cnt_losses"],
    }


def _aggregate_by_bot_real(filters: PnlFilters) -> dict[int, dict]:
    """Per-bot rollup for real trades. bot_id -> aggregate dict."""
    rows = (
        _real_queryset(filters)
        .exclude(bot_id__isnull=True)
        .values("bot_id")
        .annotate(
            sum_profit_usdt=Coalesce(Sum("profit_usdt"), _zero()),
            cnt_total=Count("id"),
            cnt_wins=Count("id", filter=Q(profit_usdt__gt=0)),
            cnt_losses=Count("id", filter=Q(profit_usdt__lt=0)),
        )
    )
    return {
        row["bot_id"]: {
            "profit_usdt": row["sum_profit_usdt"],
            "trades_count": row["cnt_total"],
            "wins": row["cnt_wins"],
            "losses": row["cnt_losses"],
        }
        for row in rows
    }


def _aggregate_by_bot_emulation(filters: PnlFilters) -> dict[int, dict]:
    rows = (
        _emulation_queryset(filters)
        .exclude(bot_id__isnull=True)
        .annotate(_derived_usdt=_EMU_USDT_EXPR)
        .values("bot_id")
        .annotate(
            sum_profit_usdt=Coalesce(
                Sum("_derived_usdt"),
                _zero(),
                output_field=DecimalField(max_digits=30, decimal_places=10),
            ),
            cnt_total=Count("id"),
            cnt_wins=Count("id", filter=Q(profit_percentage__gt=0)),
            cnt_losses=Count("id", filter=Q(profit_percentage__lt=0)),
        )
    )
    return {
        row["bot_id"]: {
            "profit_usdt": row["sum_profit_usdt"],
            "trades_count": row["cnt_total"],
            "wins": row["cnt_wins"],
            "losses": row["cnt_losses"],
        }
        for row in rows
    }


def _decimal_to_str(value: Decimal | int | float | None) -> str:
    if value is None:
        return "0"
    if isinstance(value, Decimal):
        # Quantize to 6 places — matches Trade.profit_usdt precision.
        return f"{value.quantize(Decimal('0.000001'))}"
    return f"{Decimal(value).quantize(Decimal('0.000001'))}"


def _bot_meta(bot_ids: Iterable[int], user_id: int) -> dict[int, dict]:
    """Hydrate bot metadata for the by_bot section.

    Returns rows only for bots owned by the requesting user. Trades whose bot
    was deleted (bot_id is NULL) are aggregated into the totals but not exposed
    in the breakdown — they have no card to map back to.
    """
    bots = BotConfig.objects.filter(owner_id=user_id, id__in=list(bot_ids)).values(
        "id",
        "coin",
        "trade_mode",
        "primary_exchange",
        "secondary_exchange",
        "is_active",
    )
    return {bot["id"]: bot for bot in bots}


def aggregate_pnl(filters: PnlFilters) -> dict:
    """Build the full PnL response payload.

    Always returns both modes (with zeros if empty) so the frontend can render
    a stable layout regardless of which modes the user actually trades.
    """
    include_real = filters.trade_mode in (None, "real")
    include_emu = filters.trade_mode in (None, "emulator")

    real_totals = _aggregate_real(filters) if include_real else {
        "profit_usdt": _zero(), "trades_count": 0, "wins": 0, "losses": 0,
    }
    emu_totals = _aggregate_emulation(filters) if include_emu else {
        "profit_usdt": _zero(), "trades_count": 0, "wins": 0, "losses": 0,
    }

    real_by_bot = _aggregate_by_bot_real(filters) if include_real else {}
    emu_by_bot = _aggregate_by_bot_emulation(filters) if include_emu else {}

    all_bot_ids = set(real_by_bot.keys()) | set(emu_by_bot.keys())
    bot_meta = _bot_meta(all_bot_ids, filters.user_id)

    by_bot_payload: list[dict] = []
    for bot_id in all_bot_ids:
        meta = bot_meta.get(bot_id)
        if meta is None:
            # bot belongs to another user (defence-in-depth — queryset already
            # filters by owner) or was deleted between queries; skip.
            continue
        r = real_by_bot.get(bot_id) or {"profit_usdt": _zero(), "trades_count": 0, "wins": 0, "losses": 0}
        e = emu_by_bot.get(bot_id) or {"profit_usdt": _zero(), "trades_count": 0, "wins": 0, "losses": 0}
        total_usdt = (r["profit_usdt"] or _zero()) + (e["profit_usdt"] or _zero())
        total_count = r["trades_count"] + e["trades_count"]
        by_bot_payload.append({
            "bot_id": bot_id,
            "coin": meta["coin"],
            "trade_mode": meta["trade_mode"],
            "primary_exchange": meta["primary_exchange"],
            "secondary_exchange": meta["secondary_exchange"],
            "is_active": meta["is_active"],
            "profit_usdt": _decimal_to_str(total_usdt),
            "trades_count": total_count,
            "wins": r["wins"] + e["wins"],
            "losses": r["losses"] + e["losses"],
            "real": {
                "profit_usdt": _decimal_to_str(r["profit_usdt"]),
                "trades_count": r["trades_count"],
                "wins": r["wins"],
                "losses": r["losses"],
            },
            "emulator": {
                "profit_usdt": _decimal_to_str(e["profit_usdt"]),
                "trades_count": e["trades_count"],
                "wins": e["wins"],
                "losses": e["losses"],
            },
        })

    # Sort by absolute USDT impact descending so the worst/best contributors
    # surface first in the table.
    by_bot_payload.sort(key=lambda row: abs(Decimal(row["profit_usdt"])), reverse=True)

    total_usdt = (real_totals["profit_usdt"] or _zero()) + (emu_totals["profit_usdt"] or _zero())
    total_trades = real_totals["trades_count"] + emu_totals["trades_count"]
    total_wins = real_totals["wins"] + emu_totals["wins"]
    total_losses = real_totals["losses"] + emu_totals["losses"]
    win_rate = (total_wins / total_trades * 100) if total_trades else 0

    return {
        "from": filters.date_from.isoformat() if filters.date_from else None,
        "to": filters.date_to.isoformat() if filters.date_to else None,
        "total": {
            "profit_usdt": _decimal_to_str(total_usdt),
            "trades_count": total_trades,
            "wins": total_wins,
            "losses": total_losses,
            "win_rate": round(win_rate, 2),
        },
        "real": {
            "profit_usdt": _decimal_to_str(real_totals["profit_usdt"]),
            "trades_count": real_totals["trades_count"],
            "wins": real_totals["wins"],
            "losses": real_totals["losses"],
        },
        "emulator": {
            "profit_usdt": _decimal_to_str(emu_totals["profit_usdt"]),
            "trades_count": emu_totals["trades_count"],
            "wins": emu_totals["wins"],
            "losses": emu_totals["losses"],
        },
        "by_bot": by_bot_payload,
    }

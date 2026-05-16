"""Enforce one active trade per bot.

Adds a partial unique index on `bot` for rows with `status='open'` on both
`EmulationTrade` and `Trade`. Before applying the index we reconcile any
existing orphan duplicates so AddConstraint does not fail on legacy data —
the most recent `open` row per bot stays open, older duplicates are closed
with `close_reason='error'` (Trade only; EmulationTrade does not carry a
close_reason) and `closed_at=now()`.

Reverse migration drops the constraints and leaves any closed-by-orphan-cleanup
rows as-is; we cannot reliably tell them apart from genuine error closes.
"""

from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone


def reconcile_orphan_open_trades(apps, schema_editor):
    """Close all but the most-recent `open` trade per bot.

    Runs on both EmulationTrade and Trade. Trade rows without a `bot` FK
    (runtime-config-owned) are skipped — the new partial unique index does
    not cover them either.
    """

    now = timezone.now()

    EmulationTrade = apps.get_model("bots", "EmulationTrade")
    Trade = apps.get_model("bots", "Trade")

    # ----- EmulationTrade -----
    em_dupes = (
        EmulationTrade.objects.filter(status="open", bot__isnull=False)
        .values("bot")
        .annotate(c=models.Count("id"))
        .filter(c__gt=1)
        .values_list("bot", flat=True)
    )
    for bot_id in list(em_dupes):
        rows = list(
            EmulationTrade.objects.filter(bot_id=bot_id, status="open").order_by(
                "-opened_at"
            )
        )
        # Keep rows[0] (most recent); close the rest.
        stale_ids = [r.id for r in rows[1:]]
        if stale_ids:
            EmulationTrade.objects.filter(id__in=stale_ids).update(
                status="closed",
                closed_at=now,
            )

    # ----- Trade -----
    t_dupes = (
        Trade.objects.filter(status="open", bot__isnull=False)
        .values("bot")
        .annotate(c=models.Count("id"))
        .filter(c__gt=1)
        .values_list("bot", flat=True)
    )
    for bot_id in list(t_dupes):
        rows = list(
            Trade.objects.filter(bot_id=bot_id, status="open").order_by(
                "-opened_at"
            )
        )
        stale_ids = [r.id for r in rows[1:]]
        if stale_ids:
            Trade.objects.filter(id__in=stale_ids).update(
                status="closed",
                close_reason="error",
                closed_at=now,
            )


def noop_reverse(apps, schema_editor):
    """Reverse is a no-op: we cannot reliably re-open closed rows."""

    return


class Migration(migrations.Migration):

    dependencies = [
        ("bots", "0020_rename_max_trade_duration_to_seconds"),
    ]

    operations = [
        migrations.RunPython(reconcile_orphan_open_trades, noop_reverse),
        migrations.AddConstraint(
            model_name="emulationtrade",
            constraint=models.UniqueConstraint(
                fields=("bot",),
                condition=Q(status="open"),
                name="unique_open_emulation_trade_per_bot",
            ),
        ),
        migrations.AddConstraint(
            model_name="trade",
            constraint=models.UniqueConstraint(
                fields=("bot",),
                condition=Q(status="open") & Q(bot__isnull=False),
                name="unique_open_trade_per_bot",
            ),
        ),
    ]

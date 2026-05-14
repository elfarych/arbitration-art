from django.db import migrations, models


def minutes_to_seconds(apps, schema_editor):
    BotConfig = apps.get_model("bots", "BotConfig")
    BotConfig.objects.all().update(
        max_trade_duration_seconds=models.F("max_trade_duration_seconds") * 60
    )


def seconds_to_minutes(apps, schema_editor):
    BotConfig = apps.get_model("bots", "BotConfig")
    BotConfig.objects.all().update(
        max_trade_duration_seconds=models.F("max_trade_duration_seconds") / 60
    )


class Migration(migrations.Migration):

    dependencies = [
        ("bots", "0019_alter_botconfig_last_command_and_more"),
    ]

    operations = [
        migrations.RenameField(
            model_name="botconfig",
            old_name="max_trade_duration_minutes",
            new_name="max_trade_duration_seconds",
        ),
        migrations.RunPython(minutes_to_seconds, seconds_to_minutes),
        migrations.AlterField(
            model_name="botconfig",
            name="max_trade_duration_seconds",
            field=models.PositiveIntegerField(default=3600, verbose_name="max trade duration (s)"),
        ),
    ]

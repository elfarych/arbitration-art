/** One notification pass: fetch active configs → group by compute params →
 * compute the screen per group → per config, match nearest-level proximity →
 * de-dup → send Telegram alerts.

Configs are grouped by (timeframe, natrMultiplier, minGap, minVolume) so the
expensive level computation runs once per distinct parameter set, not once per
user. Within a group, each config applies its own favorites filter, distance
threshold and de-dup. */

import type { Config } from '../config/env';
import type { Logger } from '../utils/logger';
import type { CandleSource } from '../redis/candle-source';
import type { NotifyStateStore } from '../state/notify-state';
import type { TelegramClient } from '../telegram/telegram-client';
import type { DjangoClient, NotificationConfig } from '../services/django-client';
import type { LevelView, ScreenerEntry } from '../levels/types';
import { computeScreener, resolveLevelParams, type ComputeOptions } from '../lib/screener-compute';

interface ConfigGroup {
  opts: ComputeOptions;
  configs: NotificationConfig[];
}

export class Notifier {
  constructor(
    private readonly config: Config,
    private readonly source: CandleSource,
    private readonly django: DjangoClient,
    private readonly state: NotifyStateStore,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    const startedAt = Date.now();
    const configs = await this.django.getActiveConfigs();
    if (configs.length === 0) {
      this.logger.debug('no active notification configs');
      return;
    }

    const groups = this.groupConfigs(configs, startedAt);
    const pending: Promise<boolean>[] = [];

    for (const group of groups.values()) {
      const entries = await computeScreener(this.source, group.opts);
      if (!entries || entries.length === 0) {
        continue;
      }
      const bySymbol = new Map<string, ScreenerEntry>(entries.map((entry) => [entry.symbol, entry]));

      for (const cfg of group.configs) {
        const symbols = cfg.onlyFavorites
          ? cfg.favorites.map((symbol) => symbol.toUpperCase())
          : [...bySymbol.keys()];

        for (const symbol of symbols) {
          const entry = bySymbol.get(symbol);
          const level = entry?.nearest;
          if (!entry || !level) {
            continue;
          }
          const metric = cfg.distanceMode === 'natr' ? level.distanceNatr : level.distancePct;
          if (metric === null || metric > cfg.distanceValue) {
            continue;
          }
          pending.push(this.maybeNotify(cfg, entry, level, metric, startedAt));
        }
      }
    }

    const results = await Promise.allSettled(pending);
    const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    this.logger.info(
      { configs: configs.length, groups: groups.size, candidates: pending.length, sent, ms: Date.now() - startedAt },
      'notifier tick',
    );
  }

  /** Group configs by the parameters that change the computed level set. */
  private groupConfigs(configs: readonly NotificationConfig[], now: number): Map<string, ConfigGroup> {
    const groups = new Map<string, ConfigGroup>();
    for (const cfg of configs) {
      const key = `${cfg.timeframe}|${cfg.natrMultiplier}|${cfg.minGap}|${cfg.minVolume}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          opts: {
            timeframe: cfg.timeframe,
            params: resolveLevelParams(this.config.levels, {
              natrMultiplier: cfg.natrMultiplier,
              minGap: cfg.minGap,
            }),
            minVolume: cfg.minVolume > 0 ? cfg.minVolume : undefined,
            volume: this.config.volume,
            now,
          },
          configs: [],
        };
        groups.set(key, group);
      }
      group.configs.push(cfg);
    }
    return groups;
  }

  /** Apply de-dup, then send. Returns true if a message was actually delivered. */
  private async maybeNotify(
    cfg: NotificationConfig,
    entry: ScreenerEntry,
    level: LevelView,
    metric: number,
    now: number,
  ): Promise<boolean> {
    const should = await this.state.shouldNotify(
      cfg.ownerId,
      cfg.timeframe,
      entry.symbol,
      level.price,
      now,
    );
    if (!should) {
      return false;
    }
    return this.telegram.sendMessage(cfg.chatId, this.buildMessage(cfg, entry, level, metric));
  }

  private buildMessage(
    cfg: NotificationConfig,
    entry: ScreenerEntry,
    level: LevelView,
    metric: number,
  ): string {
    const link = `${this.config.siteBaseUrl}/#/levels/${entry.symbol}?tf=${cfg.timeframe}`;
    const sideRu = level.side === 'resistance' ? 'сопротивления' : 'поддержки';
    const unit = cfg.distanceMode === 'natr' ? ' NATR' : '%';
    return [
      `🔔 <b>${entry.symbol}</b> · ${cfg.timeframe}`,
      `Цена ${formatPrice(entry.price)} подошла к уровню ${sideRu} ${formatPrice(level.price)}`,
      `Дистанция: ${metric.toFixed(2)}${unit} · касаний: ${level.touches}`,
      `<a href="${link}">Открыть на скринере</a>`,
    ].join('\n');
  }
}

/** Compact price formatting across the wide range of futures prices. */
function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return String(value);
  }
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

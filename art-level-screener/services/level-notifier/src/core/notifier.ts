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
import type { PriceNotifyStateStore } from '../state/price-state';
import type { TelegramClient } from '../telegram/telegram-client';
import type { DjangoClient, NotificationConfig, PriceNotification } from '../services/django-client';
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
    private readonly priceState: PriceNotifyStateStore,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
  ) {}

  async runOnce(): Promise<void> {
    const startedAt = Date.now();
    // Price-crossing pass is independent of level proximity: its failures must
    // not abort the level pass and vice versa.
    try {
      await this.runPriceChecks(startedAt);
    } catch (error) {
      this.logger.error({ err: error }, 'price notifier pass failed');
    }

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
    // Carry the level-detection params so the coin page renders a chart with the
    // same levels this alert was computed from. minVolume is a universe pre-filter
    // (irrelevant to a single coin), so it is not part of the link.
    const query = new URLSearchParams({
      tf: cfg.timeframe,
      natrMultiplier: String(cfg.natrMultiplier),
      minGap: String(cfg.minGap),
    });
    const link = `${this.config.siteBaseUrl}/#/levels/${entry.symbol}?${query.toString()}`;
    const sideRu = level.side === 'resistance' ? 'сопротивления' : 'поддержки';
    const unit = cfg.distanceMode === 'natr' ? ' NATR' : '%';
    return [
      `🔔 <b>${entry.symbol}</b> · ${cfg.timeframe}`,
      `Цена ${formatPrice(entry.price)} подошла к уровню ${sideRu} ${formatPrice(level.price)}`,
      `Дистанция: ${metric.toFixed(2)}${unit} · касаний: ${level.touches}`,
      `<a href="${link}">Открыть на скринере</a>`,
    ].join('\n');
  }

  /** One price-crossing pass: fetch active alerts → read latest prices → fire the
   * ones whose price crossed the target. No level computation needed. */
  private async runPriceChecks(now: number): Promise<void> {
    if (!this.config.price.enabled) {
      return;
    }
    const notifications = await this.django.getActivePriceNotifications();
    if (notifications.length === 0) {
      this.logger.debug('no active price notifications');
      return;
    }
    const symbols = [...new Set(notifications.map((n) => n.symbol.toUpperCase()))];
    const prices = await this.source.getLatestPrices(symbols);

    const pending: Promise<boolean>[] = [];
    for (const notification of notifications) {
      const latest = prices.get(notification.symbol.toUpperCase());
      // Symbol outside the connector universe / no price yet, or a frozen feed.
      if (!latest || now - latest.updatedAt > this.config.price.maxStalenessMs) {
        continue;
      }
      // direction is inferred at creation so the condition starts false; a single
      // level comparison is enough, and one-shot disable makes it fire once.
      const crossed =
        notification.direction === 'above'
          ? latest.price >= notification.targetPrice
          : latest.price <= notification.targetPrice;
      if (!crossed) {
        continue;
      }
      pending.push(this.firePriceAlert(notification, latest.price, now));
    }

    const results = await Promise.allSettled(pending);
    const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    this.logger.info(
      { notifications: notifications.length, candidates: pending.length, sent, ms: Date.now() - now },
      'price notifier tick',
    );
  }

  /** Guard against a double fire, send, then one-shot disable in Django on success. */
  private async firePriceAlert(
    notification: PriceNotification,
    currentPrice: number,
    now: number,
  ): Promise<boolean> {
    const reserved = await this.priceState.shouldFire(notification.id, now);
    if (!reserved) {
      return false;
    }
    const delivered = await this.telegram.sendMessage(
      notification.chatId,
      this.buildPriceMessage(notification, currentPrice),
    );
    if (delivered) {
      // One-shot: disable in Django; the guard covers the window until that
      // disable propagates to the feed.
      await this.django.markPriceNotificationTriggered(notification.id);
    } else {
      // Delivery failed (transient 5xx/network after retries, or 4xx like a user
      // who has not /started). No disable happened, so release the guard — the
      // alert stays armed and the next tick retries instead of waiting out guardMs.
      await this.priceState.release(notification.id);
    }
    return delivered;
  }

  private buildPriceMessage(notification: PriceNotification, currentPrice: number): string {
    const verb = notification.direction === 'above' ? 'выросла до' : 'упала до';
    const link = `${this.config.siteBaseUrl}/#/levels/${notification.symbol}`;
    return [
      `🔔 <b>${notification.symbol}</b>`,
      `Цена ${verb} ${formatPrice(notification.targetPrice)}`,
      `Текущая: ${formatPrice(currentPrice)}`,
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

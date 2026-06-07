/** Telegram command listener — long-polls updates and answers `/start`.

When a user sends `/start`, the bot replies with their numeric `chat_id` so they
can paste it into the level-notification settings. This is the inbound half of the
bot (the notifier only sends); both share the same bot token.

Long polling (not a webhook) is used so it works without a public HTTPS endpoint.
The acknowledged `offset` is persisted in Redis so a restart does not re-answer
old `/start` commands. NOTE: Telegram allows only ONE `getUpdates` consumer per
bot token — running a second notifier instance (or a webhook) makes Telegram
return 409; the loop logs and backs off. */

import type { Redis } from 'ioredis';

import type { Logger } from '../utils/logger';
import type { TelegramClient, TelegramUpdate } from './telegram-client';

const OFFSET_KEY = 'level-notifier:telegram:offset';
const LONG_POLL_SEC = 25;
const ERROR_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramCommandListener {
  private offset: number | undefined;
  private stopped = false;

  constructor(
    private readonly client: TelegramClient,
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /** Load the persisted offset and start the long-poll loop (fire-and-forget). */
  async start(): Promise<void> {
    const stored = await this.redis.get(OFFSET_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) {
        this.offset = parsed;
      }
    }
    void this.loop();
    this.logger.info('telegram command listener started (long polling /start)');
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.client.getUpdates(this.offset, LONG_POLL_SEC);
        if (this.stopped) {
          break;
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handle(update);
        }
        if (updates.length > 0 && !this.stopped) {
          await this.redis.set(OFFSET_KEY, String(this.offset));
        }
      } catch (error) {
        if (this.stopped) {
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        // 409 (webhook set / another poller) lands here too — back off, don't hot-loop.
        this.logger.warn({ err: message }, 'telegram getUpdates failed; backing off');
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    // Handles bare `/start` and deep-link `/start <payload>`.
    if (!message || !text || !text.startsWith('/start')) {
      return;
    }
    const chatId = String(message.chat.id);
    const reply = [
      'Ваш <b>chat_id</b>:',
      `<code>${chatId}</code>`,
      '',
      'Вставьте его в настройки уведомлений по уровням на скринере.',
    ].join('\n');
    // sendMessage never throws (returns false on failure) — safe inside the loop.
    await this.client.sendMessage(chatId, reply);
  }
}

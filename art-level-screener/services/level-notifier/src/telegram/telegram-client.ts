/** Telegram Bot API client — sends level-proximity alerts and reads updates.

One bot per service (TELEGRAM_BOT_TOKEN); the chat_id is per user. Sends are
best-effort: a wrong chat_id or a user who never `/start`ed the bot yields a 4xx
(typically 403/400) — logged at warn and never retried (retrying can't fix it) so
a single bad config never blocks the tick. Network/5xx errors are retried with
backoff. `getUpdates` is used for long polling so the bot can answer `/start`. */

import { request } from 'undici';

import type { Logger } from '../utils/logger';

const TELEGRAM_API = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal subset of a Telegram update we care about (message text + chat). */
export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramClient {
  private readonly base: string;

  constructor(
    botToken: string,
    private readonly logger: Logger,
  ) {
    this.base = `${TELEGRAM_API}/bot${botToken}`;
  }

  /**
   * Send an HTML message. Returns true on delivery, false on a permanent failure
   * (bad chat_id / bot not started). Throws only if all retries on transient
   * errors are exhausted — caught by the caller so one failure can't fail the tick.
   */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      // No site link preview in the alert (and the /start reply has no link anyway).
      disable_web_page_preview: true,
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await request(`${this.base}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          headersTimeout: REQUEST_TIMEOUT_MS,
          bodyTimeout: REQUEST_TIMEOUT_MS,
        });
        const status = response.statusCode;
        const responseText = await response.body.text();

        if (status === 200) {
          return true;
        }
        // 4xx is permanent (bad chat_id, bot blocked / not started) — don't retry.
        if (status >= 400 && status < 500) {
          this.logger.warn(
            { chatId, status, body: responseText.slice(0, 200) },
            'telegram send rejected (permanent) — check chat_id / bot /start',
          );
          return false;
        }
        lastError = new Error(`telegram HTTP ${status}: ${responseText.slice(0, 200)}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.warn({ chatId, err: message }, 'telegram send failed after retries');
    return false;
  }

  /**
   * Long-poll for updates. `offset` acknowledges everything below it; `timeoutSec`
   * is the server-side long-poll wait (the HTTP timeout is set above it). Only
   * `message` updates are requested. Throws on non-200 (e.g. 409 Conflict when a
   * webhook is set or another poller exists) — the caller backs off and retries.
   */
  async getUpdates(offset: number | undefined, timeoutSec: number): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams();
    if (offset !== undefined) {
      params.set('offset', String(offset));
    }
    params.set('timeout', String(timeoutSec));
    params.set('allowed_updates', '["message"]');

    // The HTTP read must outlast the server-side long-poll wait.
    const httpTimeoutMs = (timeoutSec + 10) * 1000;
    const response = await request(`${this.base}/getUpdates?${params.toString()}`, {
      method: 'GET',
      headersTimeout: httpTimeoutMs,
      bodyTimeout: httpTimeoutMs,
    });
    const text = await response.body.text();
    if (response.statusCode !== 200) {
      throw new Error(`telegram getUpdates HTTP ${response.statusCode}: ${text.slice(0, 200)}`);
    }
    const data = JSON.parse(text) as { ok: boolean; result?: TelegramUpdate[] };
    return data.result ?? [];
  }
}

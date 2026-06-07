/** Small undici-based JSON HTTP helper with retry/backoff. */

import { request } from 'undici';

import type { Logger } from './logger';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Status codes treated as success; everything else throws HttpError. */
  expectedStatuses?: number[];
}

export async function requestJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15_000,
    expectedStatuses = [200],
  } = options;

  const finalHeaders: Record<string, string> = { ...headers };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    if (!finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  }

  const response = await request(url, {
    method,
    headers: finalHeaders,
    body: payload,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const text = await response.body.text();

  if (!expectedStatuses.includes(response.statusCode)) {
    throw new HttpError(
      `HTTP ${response.statusCode} for ${method} ${url}: ${text.slice(0, 300)}`,
      response.statusCode,
      text,
    );
  }
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry an idempotent async op with exponential backoff. */
export async function withRetry<T>(
  label: string,
  op: () => Promise<T>,
  logger: Logger,
  attempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) {
        break;
      }
      const delay = baseDelayMs * 2 ** i;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`${label} attempt ${i + 1}/${attempts} failed: ${message}; retry in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

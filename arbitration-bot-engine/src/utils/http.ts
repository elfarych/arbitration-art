/**
 * Minimal HTTP utilities used by native exchange REST clients.
 *
 * The engine deliberately avoids axios on the hot path: ccxt-free signing
 * and direct fetch() give predictable latency and a much smaller dependency
 * surface. Existing axios-based call sites continue to work; new clients
 * built on this module use native fetch directly.
 */

export class HttpError extends Error {
    constructor(
        message: string,
        public readonly status: number | null,
        public readonly body: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

export interface RequestJsonOptions extends RequestInit {
    /** HTTP statuses accepted as success. Defaults to `[200]`. */
    expectedStatuses?: number[];
    /** Request timeout in milliseconds. Defaults to 10000. */
    timeoutMs?: number;
}

/**
 * Performs a JSON HTTP request with explicit timeout and accepted-status
 * gating. Throws `HttpError` for any non-accepted status so callers can map
 * exchange-specific error envelopes to a normalized Error.
 */
export async function requestJson<T>(url: string, options: RequestJsonOptions = {}): Promise<T> {
    const { expectedStatuses = [200], timeoutMs = 10_000, ...init } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        if (!expectedStatuses.includes(response.status)) {
            throw new HttpError(`HTTP ${response.status} for ${url}: ${text.slice(0, 512)}`, response.status, text);
        }
        if (!text) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new HttpError(`Invalid JSON from ${url}: ${text.slice(0, 256)}`, response.status, text);
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build a stable query string from a record of primitives. Keys with
 * undefined/null/empty values are omitted. Use this for both URL params and
 * signed payloads so the sign string matches what we send.
 */
export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.join('&');
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

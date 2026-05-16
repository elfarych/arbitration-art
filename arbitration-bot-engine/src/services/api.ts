import { config } from '../config.js';
import type { TradeClosePayload, TradeOpenPayload, TradeRecord } from '../types/index.js';
import { requestJson } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const TAG = 'API';
const REQUEST_TIMEOUT_MS = 15_000;
// Defaults for retrying critical bootstrap GETs (`getOpenTrades`,
// `getOpenEmulationTrades`, `getTotalTradesCount`). A short backoff is enough
// for Django flap / Traefik 502s during rolling deploys; longer is wasted
// since the engine cannot serve trades while the orderbook subscriptions are
// blocked anyway.
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Retries an idempotent async operation with exponential backoff.
 * Use ONLY for idempotent reads (GET) on the engine bootstrap path —
 * never wrap POST/PATCH calls; a partial Django failure can persist a row
 * even when the HTTP response did not return, and a retry on POST would
 * silently create duplicates. The new EmulationTrade unique constraint
 * defends against that, but the contract here is "only safe operations".
 */
async function withRetry<T>(
    label: string,
    op: () => Promise<T>,
    attempts: number = RETRY_ATTEMPTS,
    baseDelayMs: number = RETRY_BASE_DELAY_MS,
): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await op();
        } catch (e: any) {
            lastErr = e;
            if (i === attempts - 1) break;
            const delay = baseDelayMs * Math.pow(2, i);
            logger.warn(TAG, `${label} attempt ${i + 1}/${attempts} failed: ${e.message}; retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

const baseUrl = config.djangoApiUrl.replace(/\/$/, '');
const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Service-Token': config.serviceToken,
};

interface DjangoListResponse<T> {
    count?: number;
    results?: T[];
}

export interface EngineBootstrapBot {
    bot_id: number;
    owner_id?: number;
    config: Record<string, any>;
    keys: Record<string, string>;
}

interface EngineBootstrapResponse {
    bots: EngineBootstrapBot[];
}

// DRF returns 201 Created for POST that creates a resource (trades),
// 200 OK for GET/PATCH/action endpoints, and 204 No Content for some
// service-only writes. `requestJson` defaults to [200] only — without
// the explicit list a successful POST would surface as `HttpError` and
// the engine would refuse to update its in-memory trade state even
// though Django persisted the row.
const DJANGO_OK_STATUSES = [200, 201, 204];

async function djangoRequest<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number> } = {},
): Promise<T> {
    const query = options.query
        ? new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)])).toString()
        : '';
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    return requestJson<T>(url, {
        method,
        headers: authHeaders,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
        expectedStatuses: DJANGO_OK_STATUSES,
    });
}

/**
 * Thin adapter around Django trade endpoints.
 *
 * BotTrader does not know endpoint URLs or pagination formats; it calls this
 * module with normalised payloads and receives normalised TradeRecord objects.
 * Authentication is via `X-Service-Token` shared with Django; no JWT is used
 * on the service-to-service channel.
 */
export const api = {
    async openTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            const data = await djangoRequest<TradeRecord>('POST', '/bots/real-trades/', { body: payload });
            logger.info(TAG, `Trade opened in Django: ID=${data.id}, coin=${data.coin}`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `openTrade failed: ${e.message}`);
            throw e;
        }
    },

    async closeTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            const data = await djangoRequest<TradeRecord>('PATCH', `/bots/real-trades/${id}/`, { body: payload });
            logger.info(TAG, `Trade closed in Django: ID=${id}, profit=${payload.profit_usdt} USDT`);
            return data;
        } catch (e: any) {
            logger.error(TAG, `closeTrade failed for ID=${id}: ${e.message}`);
            throw e;
        }
    },

    async updateTrade(id: number, payload: Record<string, any>): Promise<TradeRecord> {
        return djangoRequest<TradeRecord>('PATCH', `/bots/real-trades/${id}/`, { body: payload });
    },

    async getOpenTrades(botId: number): Promise<TradeRecord[]> {
        // Retry + throw on full failure. Engine.startBot uses the result to
        // restore the active trade after a restart; silently returning [] used
        // to cause the bot to open a fresh trade in parallel with an already
        // open Django row when Django flapped during deploy.
        return withRetry(`getOpenTrades(bot=${botId})`, async () => {
            const data = await djangoRequest<DjangoListResponse<TradeRecord> | TradeRecord[]>(
                'GET',
                '/bots/real-trades/',
                { query: { status: 'open', bot_id: botId } },
            );
            if (Array.isArray(data)) return data;
            return data.results ?? [];
        });
    },

    async openEmulationTrade(payload: TradeOpenPayload): Promise<TradeRecord> {
        try {
            return await djangoRequest<TradeRecord>('POST', '/bots/trades/', { body: payload });
        } catch (e: any) {
            logger.error(TAG, `openEmulationTrade failed: ${e.message}`);
            throw e;
        }
    },

    async closeEmulationTrade(id: number, payload: TradeClosePayload): Promise<TradeRecord> {
        try {
            return await djangoRequest<TradeRecord>('PATCH', `/bots/trades/${id}/`, { body: payload });
        } catch (e: any) {
            logger.error(TAG, `closeEmulationTrade failed: ${e.message}`);
            throw e;
        }
    },

    async updateEmulationTrade(id: number, payload: Record<string, any>): Promise<TradeRecord> {
        return djangoRequest<TradeRecord>('PATCH', `/bots/trades/${id}/`, { body: payload });
    },

    // Bootstrap is invoked once on engine startup. The engine self-identifies by
    // serviceUrl so Django returns only bots whose BotConfig.service_url matches —
    // mandatory for multi-engine deployments to avoid cross-loading.
    async getActiveBotPayloads(serviceUrl: string): Promise<EngineBootstrapBot[]> {
        const data = await djangoRequest<EngineBootstrapResponse>(
            'GET',
            '/bots/engine-bootstrap/',
            { query: { service_url: serviceUrl } },
        );
        return data?.bots ?? [];
    },

    async getOpenEmulationTrades(botId: number): Promise<TradeRecord[]> {
        // Retry + throw on full failure; see getOpenTrades for rationale.
        return withRetry(`getOpenEmulationTrades(bot=${botId})`, async () => {
            const data = await djangoRequest<DjangoListResponse<TradeRecord> | TradeRecord[]>(
                'GET',
                '/bots/trades/',
                { query: { status: 'open', bot_id: botId } },
            );
            if (Array.isArray(data)) return data;
            return data.results ?? [];
        });
    },

    // Used by BotTrader to enforce BotConfig.max_trades across engine
    // restarts. We ask Django for `page_size=1` and read the paginated
    // `count` — the body shape we care about is cheap (one row) but the
    // count covers the full filter. No status filter: max_trades counts
    // every trade the bot ever opened, including the one currently active
    // and the ones that already closed.
    async getTotalTradesCount(botId: number, isReal: boolean): Promise<number> {
        const path = isReal ? '/bots/real-trades/' : '/bots/trades/';
        // Retries; on full failure throws so the caller can decide whether
        // to fall back to 0 (loose max_trades cap) or abort the bot start.
        return withRetry(`getTotalTradesCount(bot=${botId}, real=${isReal})`, async () => {
            const data = await djangoRequest<DjangoListResponse<TradeRecord> | TradeRecord[]>(
                'GET',
                path,
                { query: { bot_id: botId, page_size: 1 } },
            );
            if (Array.isArray(data)) return data.length;
            return data.count ?? data.results?.length ?? 0;
        });
    },

    /**
     * Recovery probe used after `openTrade` / `openEmulationTrade` rejects.
     * A network failure mid-POST can persist the trade in Django even though
     * the HTTP response never reached the engine; the engine then thinks
     * no trade is active and would open a duplicate on the next tick. This
     * call returns the most recently opened `open` trade for the given bot
     * and coin (or null) so the caller can adopt it as `activeTrade` instead.
     */
    async findOrphanOpenTrade(botId: number, coin: string, isReal: boolean): Promise<TradeRecord | null> {
        const list = isReal
            ? await this.getOpenTrades(botId)
            : await this.getOpenEmulationTrades(botId);
        const matching = list
            .filter(t => t.coin === coin && t.status === 'open')
            .sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
        return matching[0] ?? null;
    },
};

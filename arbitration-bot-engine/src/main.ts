import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { Engine } from './classes/Engine.js';
import {
    isSupportedExchange,
    testConnection,
    testTrade,
} from './exchanges/exchange-tester.js';

// Constant-time comparison of the shared service token. A plain `!==` leaks
// the position of the first mismatching byte through response timing, which
// would let an attacker on the same network recover the token byte-by-byte.
// Django side already uses hmac.compare_digest; the engine matches.
const SERVICE_TOKEN_BUF = Buffer.from(config.serviceToken, 'utf8');
function isValidServiceToken(provided: unknown): boolean {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const providedBuf = Buffer.from(provided, 'utf8');
    if (providedBuf.length !== SERVICE_TOKEN_BUF.length) return false;
    return timingSafeEqual(providedBuf, SERVICE_TOKEN_BUF);
}

// Fastify is used only as a thin control plane. The actual trading lifecycle is
// owned by Engine/BotTrader; HTTP handlers should translate requests into engine
// method calls and return a simple success/error response to Django.
const fastify = Fastify({ logger: false });
const engine = new Engine();

// Django is expected to call this local service directly. CORS is open because
// the process is intended to run behind local networking or infrastructure-level
// access controls, not as a public browser-facing API.
fastify.register(cors, { origin: '*' });

fastify.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS') {
        return;
    }

    const token = request.headers['x-service-token'];
    if (!isValidServiceToken(token)) {
        return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
});

function requireFields(body: any, fields: readonly string[]): string | null {
    if (!body || typeof body !== 'object') {
        return 'Body must be a JSON object';
    }
    for (const f of fields) {
        if (body[f] === undefined || body[f] === null) {
            return `Missing required field: ${f}`;
        }
    }
    return null;
}

fastify.post('/engine/bot/start', async (request, reply) => {
    // Payload shape is produced by Django's apps.bots.api.views.get_engine_payload:
    // { bot_id, config, keys }. The engine trusts Django as the source of bot
    // ownership and validation but still rejects structurally invalid payloads
    // so the trading paths only execute with the data they expect.
    const body = request.body as any;
    const err = requireFields(body, ['bot_id', 'config', 'keys']);
    if (err) return reply.status(400).send({ success: false, error: err });
    if (typeof body.bot_id !== 'number') {
        return reply.status(400).send({ success: false, error: 'bot_id must be a number' });
    }
    if (typeof body.config !== 'object' || typeof body.keys !== 'object') {
        return reply.status(400).send({ success: false, error: 'config and keys must be objects' });
    }
    try {
        await engine.startBot(body.bot_id, body.config, body.keys);
        return { success: true };
    } catch (e: any) {
        logger.error('API', `Failed to start bot ${body.bot_id}: ${e.message}`);
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/stop', async (request, reply) => {
    // Stop is intentionally keyed only by bot_id. Django performs user scoping
    // before issuing this command.
    const body = request.body as any;
    const err = requireFields(body, ['bot_id']);
    if (err) return reply.status(400).send({ success: false, error: err });
    try {
        await engine.stopBot(body.bot_id);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/sync', async (request, reply) => {
    // Sync updates an already-running trader in memory. If the bot is not loaded
    // in this process, Engine logs a warning instead of creating a new trader.
    const body = request.body as any;
    const err = requireFields(body, ['bot_id', 'config']);
    if (err) return reply.status(400).send({ success: false, error: err });
    try {
        engine.syncBot(body.bot_id, body.config);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/pause', async (request, reply) => {
    // Pause is a soft stop: the trader stays registered with its WS streams
    // and timeout loop intact, but `bot.is_active=false` in the synced config
    // makes BotTrader.checkSpreads bail out before any new open. The active
    // trade (if any) keeps closing on profit / timeout / drawdown via the
    // existing checkExit/checkTimeouts paths. Positions are never closed by
    // this command — operators must use force-close or delete the bot for
    // that. Payload matches /engine/bot/sync so Django can reuse the same
    // builder.
    const body = request.body as any;
    const err = requireFields(body, ['bot_id', 'config']);
    if (err) return reply.status(400).send({ success: false, error: err });
    try {
        engine.pauseBot(body.bot_id, body.config);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/force-close', async (request, reply) => {
    // Force close is a manual safety action. BotTrader will attempt to close the
    // active trade using emergency pricing if a trade is currently open.
    const body = request.body as any;
    const err = requireFields(body, ['bot_id']);
    if (err) return reply.status(400).send({ success: false, error: err });
    try {
        await engine.forceClose(body.bot_id);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

// On-demand probes invoked from Django's user profile. They take user-supplied
// credentials directly in the request body so the engine does not need a
// persistent registry of keys; Django reads them from UserExchangeKeys and
// forwards them per request.
fastify.post('/engine/exchange/test-connection', async (request, reply) => {
    const body = request.body as any;
    const err = requireFields(body, ['exchange', 'api_key', 'secret']);
    if (err) return reply.status(400).send({ success: false, error: err });
    if (!isSupportedExchange(body.exchange)) {
        return reply
            .status(400)
            .send({ success: false, error: `Unsupported exchange: ${body.exchange}` });
    }
    if (typeof body.api_key !== 'string' || typeof body.secret !== 'string') {
        return reply
            .status(400)
            .send({ success: false, error: 'api_key and secret must be strings' });
    }
    try {
        const result = await testConnection(body.exchange, body.api_key, body.secret);
        return result;
    } catch (e: any) {
        logger.error('API', `test-connection failed for ${body.exchange}: ${e.message}`);
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/exchange/test-trade', async (request, reply) => {
    const body = request.body as any;
    const err = requireFields(body, ['exchange', 'api_key', 'secret']);
    if (err) return reply.status(400).send({ success: false, error: err });
    if (!isSupportedExchange(body.exchange)) {
        return reply
            .status(400)
            .send({ success: false, error: `Unsupported exchange: ${body.exchange}` });
    }
    if (typeof body.api_key !== 'string' || typeof body.secret !== 'string') {
        return reply
            .status(400)
            .send({ success: false, error: 'api_key and secret must be strings' });
    }
    try {
        const result = await testTrade(body.exchange, body.api_key, body.secret);
        return result;
    } catch (e: any) {
        logger.error('API', `test-trade failed for ${body.exchange}: ${e.message}`);
        return reply.status(500).send({ success: false, error: e.message });
    }
});

// Liveness probe usable by Kubernetes/Docker without service-token, since the
// preHandler runs first; we exempt OPTIONS already, and most infra prefers a
// public health endpoint. We keep it under the same auth check intentionally to
// avoid leaking process state — adjust if a separate unauthed probe is needed.
fastify.get('/health', async () => ({ ok: true, bots: 0 }));

const SHUTDOWN_TIMEOUT_MS = 30_000;
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn('MAIN', `Received ${signal}, starting graceful shutdown...`);

    // Force-exit timer in case stopAll deadlocks. unref() so the timer itself
    // does not keep the event loop alive once shutdown is complete.
    const forceExitTimer = setTimeout(() => {
        logger.error('MAIN', `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
        // Close the HTTP server first so Django stops getting acks for new
        // commands while we tear traders down.
        await fastify.close().catch(e => logger.error('MAIN', `fastify.close error: ${e.message}`));
        await engine.stopAll();
        clearTimeout(forceExitTimer);
        logger.info('MAIN', 'Shutdown complete.');
        process.exit(0);
    } catch (e: any) {
        logger.error('MAIN', `Error during shutdown: ${e.message}`);
        process.exit(1);
    }
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

// Surfacing unhandled errors is critical for a real-money process: silent
// failures here have previously led to operators not noticing a crashed bot.
process.on('unhandledRejection', (reason: any) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error('MAIN', `Unhandled rejection: ${detail}`);
});
process.on('uncaughtException', (err: Error) => {
    logger.error('MAIN', `Uncaught exception: ${err.stack ?? err.message}`);
    // For uncaught exceptions we let the process die after attempting graceful
    // shutdown. Continuing in an unknown state with open positions is more
    // dangerous than restarting.
    void gracefulShutdown('uncaughtException');
});

// Bootstrap retries cover the case where the engine restarts before Django is
// reachable (typical in compose/systemd setups). Bootstrap runs asynchronously
// so the engine's own HTTP listener is available immediately for manual
// lifecycle commands and `/health` probes while restoration is in flight.
const BOOTSTRAP_MAX_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_DELAY_MS = 3_000;

async function runBootstrapWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
        if (shuttingDown) return;
        try {
            await engine.bootstrapFromDjango(config.engineServiceUrl);
            return;
        } catch (err: any) {
            logger.error(
                'MAIN',
                `Bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS} failed: ${err?.message ?? err}`,
            );
            if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, BOOTSTRAP_RETRY_DELAY_MS));
            }
        }
    }
    logger.error('MAIN', 'Bootstrap exhausted retries; engine is up but holds no traders.');
}

const start = async () => {
    try {
        // Listen on all interfaces so Django can reach the engine in local
        // Docker/network deployments as well as on bare localhost.
        await fastify.listen({ port: config.port, host: '0.0.0.0' });
        logger.info('MAIN', `🚀 Arbitration Fastify Engine running on :${config.port}`);
        // Restore in-memory bot state from Django without blocking listen.
        // startBot is idempotent against concurrent Django lifecycle commands.
        void runBootstrapWithRetry();
    } catch (err) {
        logger.error('MAIN', err as any);
        process.exit(1);
    }
};

start();

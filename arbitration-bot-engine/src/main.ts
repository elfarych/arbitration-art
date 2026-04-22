import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { Engine } from './classes/Engine.js';

// Fastify is used only as a thin control plane. The actual trading lifecycle is
// owned by Engine/BotTrader; HTTP handlers should translate requests into engine
// method calls and return a simple success/error response to Django.
const fastify = Fastify({ logger: false });
const engine = new Engine();

// Django is expected to call this local service directly. CORS is open because
// the process is intended to run behind local networking or infrastructure-level
// access controls, not as a public browser-facing API.
fastify.register(cors, { origin: '*' });

fastify.post('/engine/bot/start', async (request, reply) => {
    // Payload shape is produced by Django's apps.bots.api.views.get_engine_payload:
    // { bot_id, config, keys }. The engine trusts Django as the source of bot
    // ownership and validation.
    const payload = request.body as any; // { bot_id, config, keys }
    try {
        await engine.startBot(payload.bot_id, payload.config, payload.keys);
        return { success: true };
    } catch (e: any) {
        logger.error('API', `Failed to start bot ${payload.bot_id}: ${e.message}`);
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/stop', async (request, reply) => {
    // Stop is intentionally keyed only by bot_id. Django performs user scoping
    // before issuing this command.
    const { bot_id } = request.body as any;
    try {
        await engine.stopBot(bot_id);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/sync', async (request, reply) => {
    // Sync updates an already-running trader in memory. If the bot is not loaded
    // in this process, Engine logs a warning instead of creating a new trader.
    const payload = request.body as any; // { bot_id, config }
    try {
        engine.syncBot(payload.bot_id, payload.config);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/force-close', async (request, reply) => {
    // Force close is a manual safety action. BotTrader will attempt to close the
    // active trade using emergency pricing if a trade is currently open.
    const { bot_id } = request.body as any;
    try {
        await engine.forceClose(bot_id);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

const start = async () => {
    try {
        // Listen on all interfaces so Django can reach the engine in local
        // Docker/network deployments as well as on bare localhost.
        await fastify.listen({ port: config.port, host: '0.0.0.0' });
        logger.info('MAIN', `🚀 Arbitration Fastify Engine running on :${config.port}`);
    } catch (err) {
        logger.error('MAIN', err as any);
        process.exit(1);
    }
};

start();

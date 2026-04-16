import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { Engine } from './classes/Engine.js';

const fastify = Fastify({ logger: false });
const engine = new Engine();

fastify.register(cors, { origin: '*' });

fastify.post('/engine/bot/start', async (request, reply) => {
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
    const { bot_id } = request.body as any;
    try {
        await engine.stopBot(bot_id);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/sync', async (request, reply) => {
    const payload = request.body as any; // { bot_id, config }
    try {
        engine.syncBot(payload.bot_id, payload.config);
        return { success: true };
    } catch (e: any) {
        return reply.status(500).send({ success: false, error: e.message });
    }
});

fastify.post('/engine/bot/force-close', async (request, reply) => {
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
        await fastify.listen({ port: config.port, host: '0.0.0.0' });
        logger.info('MAIN', `🚀 Arbitration Fastify Engine running on :${config.port}`);
    } catch (err) {
        logger.error('MAIN', err as any);
        process.exit(1);
    }
};

start();

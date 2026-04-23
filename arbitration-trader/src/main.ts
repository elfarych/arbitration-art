import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { RuntimeManager } from './classes/RuntimeManager.js';
import type { RuntimeCommandPayload } from './types/index.js';
import { logger } from './utils/logger.js';

const TAG = 'MAIN';
const runtimeManager = new RuntimeManager();

function sendJson(reply: ServerResponse, statusCode: number, payload: unknown): void {
    reply.statusCode = statusCode;
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString('utf8').trim();
    if (!body) {
        return {};
    }

    return JSON.parse(body);
}

function parseRuntimeConfigId(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('runtime_config_id must be a positive integer.');
    }

    return parsed;
}

function hasValidServiceToken(request: IncomingMessage): boolean {
    const headerValue = request.headers['x-service-token'];
    const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return token === config.serviceToken;
}

const server = createServer(async (request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(reply, 200, {
            success: true,
            active_runtime_config_id: runtimeManager.getStatus().activeRuntimeConfigId,
        });
        return;
    }

    if (!hasValidServiceToken(request)) {
        sendJson(reply, 401, { success: false, error: 'Unauthorized' });
        return;
    }

    try {
        if (request.method === 'POST' && url.pathname === '/engine/trader/start') {
            const payload = await readJsonBody(request) as RuntimeCommandPayload;
            await runtimeManager.start(payload);
            sendJson(reply, 200, { success: true });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/engine/trader/sync') {
            const payload = await readJsonBody(request) as RuntimeCommandPayload;
            await runtimeManager.sync(payload);
            sendJson(reply, 200, { success: true });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/engine/trader/stop') {
            const payload = await readJsonBody(request) as { runtime_config_id?: number };
            await runtimeManager.stop(payload.runtime_config_id);
            sendJson(reply, 200, { success: true });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/engine/trader/runtime/exchange-health') {
            const payload = await readJsonBody(request) as RuntimeCommandPayload;
            const data = await runtimeManager.checkExchangeHealth(payload);
            sendJson(reply, 200, data);
            return;
        }

        if (request.method === 'GET' && url.pathname === '/engine/trader/runtime/active-coins') {
            const runtimeConfigId = parseRuntimeConfigId(url.searchParams.get('runtime_config_id'));
            const data = runtimeManager.getActiveTradesDiagnostics(runtimeConfigId);
            sendJson(reply, 200, {
                requested_runtime_config_id: data.requested_runtime_config_id,
                active_runtime_config_id: data.active_runtime_config_id,
                is_requested_runtime_active: data.is_requested_runtime_active,
                trade_count: data.trade_count,
                active_coins: data.active_coins,
            });
            return;
        }

        if (request.method === 'GET' && url.pathname === '/engine/trader/runtime/open-trades-pnl') {
            const runtimeConfigId = parseRuntimeConfigId(url.searchParams.get('runtime_config_id'));
            const data = runtimeManager.getActiveTradesDiagnostics(runtimeConfigId);
            sendJson(reply, 200, data);
            return;
        }

        if (request.method === 'GET' && url.pathname === '/engine/trader/runtime/system-load') {
            const runtimeConfigId = parseRuntimeConfigId(url.searchParams.get('runtime_config_id'));
            const data = await runtimeManager.getSystemLoad();
            sendJson(reply, 200, {
                requested_runtime_config_id: runtimeConfigId ?? null,
                active_runtime_config_id: runtimeManager.getStatus().activeRuntimeConfigId,
                ...data,
            });
            return;
        }

        sendJson(reply, 404, { success: false, error: 'Not found' });
    } catch (error: any) {
        logger.error(TAG, `Request failed: ${error.message}`);
        logger.error(TAG, error.stack || '');
        sendJson(reply, 500, { success: false, error: error.message });
    }
});

const start = async () => {
    await new Promise<void>((resolve, reject) => {
        server.listen(config.port, '0.0.0.0', () => {
            logger.info(TAG, `Trader control plane is running on :${config.port}`);
            resolve();
        });
        server.on('error', reject);
    });
};

let isShuttingDown = false;

const shutdown = async () => {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    logger.info(TAG, 'Graceful shutdown initiated.');

    try {
        await runtimeManager.shutdown();
    } catch (error: any) {
        logger.error(TAG, `Runtime shutdown failed: ${error.message}`);
    }

    server.close(() => {
        process.exit(0);
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', error => {
    logger.error(TAG, `Uncaught exception: ${error.message}`);
    logger.error(TAG, error.stack || '');
    shutdown();
});

process.on('unhandledRejection', (reason: any) => {
    logger.error(TAG, `Unhandled rejection: ${reason?.message || reason}`);
});

start().catch(error => {
    logger.error(TAG, `Failed to start trader control plane: ${error.message}`);
    logger.error(TAG, error.stack || '');
    process.exit(1);
});

import { config } from '../config.js';
import type { RuntimeManager } from '../classes/RuntimeManager.js';
import {
    parseRuntimeCommandPayload,
    parseRuntimeConfigId,
    parseStopPayload,
    PayloadValidationError,
} from '../services/runtime-payload-validation.js';
import { logger } from '../utils/logger.js';

const TAG = 'ControlPlane';
const FASTIFY_MODULE = 'fastify';

type HeaderValue = string | string[] | undefined;

interface FastifyRequestLike {
    method: string;
    url: string;
    headers: Record<string, HeaderValue>;
    body?: unknown;
    query?: Record<string, unknown>;
}

interface FastifyReplyLike {
    code(statusCode: number): FastifyReplyLike;
    send(payload: unknown): FastifyReplyLike;
}

interface FastifyInstanceLike {
    addHook(
        name: 'preHandler',
        handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void | FastifyReplyLike> | void | FastifyReplyLike,
    ): void;
    setErrorHandler(
        handler: (error: Error, request: FastifyRequestLike, reply: FastifyReplyLike) => void,
    ): void;
    get(path: string, handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown> | unknown): void;
    post(path: string, handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown> | unknown): void;
    listen(options: { port: number; host: string }): Promise<string>;
    close(): Promise<void>;
}

type FastifyFactory = (options: { logger: false }) => FastifyInstanceLike;

export interface ControlPlaneServer {
    listen(): Promise<void>;
    close(): Promise<void>;
}

export async function createControlPlaneServer(runtimeManager: RuntimeManager): Promise<ControlPlaneServer> {
    const fastify = await loadFastify();
    const app = fastify({ logger: false });

    app.addHook('preHandler', async (request, reply) => {
        if (request.method === 'GET' && request.url.split('?')[0] === '/health') {
            return;
        }

        if (!hasValidServiceToken(request)) {
            return reply.code(401).send({ success: false, error: 'Unauthorized' });
        }
    });

    app.setErrorHandler((error, _request, reply) => {
        const statusCode = error instanceof PayloadValidationError ? 400 : 500;
        logger.error(TAG, `Request failed: ${error.message}`);
        logger.error(TAG, error.stack || '');
        reply.code(statusCode).send({ success: false, error: error.message });
    });

    app.get('/health', async request => {
        if (!config.publicHealthDetails && !hasValidServiceToken(request)) {
            return {
                success: true,
                status: 'ok',
            };
        }

        const status = runtimeManager.getStatus();
        return {
            success: true,
            active_runtime_config_id: status.activeRuntimeConfigId,
            runtime_state: status.runtimeState,
            risk_locked: status.riskLocked,
            risk_incidents: status.riskIncidents,
            open_exposure: status.openExposure,
        };
    });

    app.post('/engine/trader/start', async request => {
        const payload = parseRuntimeCommandPayload(request.body);
        await runtimeManager.start(payload);
        return { success: true };
    });

    app.post('/engine/trader/sync', async request => {
        const payload = parseRuntimeCommandPayload(request.body);
        await runtimeManager.sync(payload);
        return { success: true };
    });

    app.post('/engine/trader/stop', async request => {
        const payload = parseStopPayload(request.body);
        await runtimeManager.stop(payload.runtime_config_id);
        return { success: true };
    });

    app.post('/engine/trader/runtime/exchange-health', async request => {
        const payload = parseRuntimeCommandPayload(request.body);
        return runtimeManager.checkExchangeHealth(payload);
    });

    app.get('/engine/trader/runtime/active-coins', async request => {
        const runtimeConfigId = parseRuntimeConfigId(request.query?.runtime_config_id);
        const data = runtimeManager.getActiveTradesDiagnostics(runtimeConfigId);
        return {
            requested_runtime_config_id: data.requested_runtime_config_id,
            active_runtime_config_id: data.active_runtime_config_id,
            is_requested_runtime_active: data.is_requested_runtime_active,
            trade_count: data.trade_count,
            active_coins: data.active_coins,
        };
    });

    app.get('/engine/trader/runtime/open-trades-pnl', async request => {
        const runtimeConfigId = parseRuntimeConfigId(request.query?.runtime_config_id);
        return runtimeManager.getActiveTradesDiagnostics(runtimeConfigId);
    });

    app.get('/engine/trader/runtime/system-load', async request => {
        const runtimeConfigId = parseRuntimeConfigId(request.query?.runtime_config_id);
        const data = await runtimeManager.getSystemLoad();
        const status = runtimeManager.getStatus();
        return {
            requested_runtime_config_id: runtimeConfigId ?? null,
            active_runtime_config_id: status.activeRuntimeConfigId,
            runtime_state: status.runtimeState,
            risk_locked: status.riskLocked,
            ...data,
        };
    });

    return {
        async listen(): Promise<void> {
            await app.listen({ port: config.port, host: '0.0.0.0' });
            logger.info(TAG, `Trader control plane is running on :${config.port}`);
        },
        close(): Promise<void> {
            return app.close();
        },
    };
}

async function loadFastify(): Promise<FastifyFactory> {
    const mod = await import(FASTIFY_MODULE) as unknown as { default: FastifyFactory };
    return mod.default;
}

function hasValidServiceToken(request: FastifyRequestLike): boolean {
    const headerValue = request.headers['x-service-token'];
    const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return token === config.serviceToken;
}

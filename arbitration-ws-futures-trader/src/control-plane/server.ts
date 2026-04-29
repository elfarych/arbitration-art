import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appConfig, type RuntimeCommandPayload } from '../config.js';
import { RuntimeConfigClient } from '../django-sync/runtime-config-client.js';
import { RuntimeErrorReporter } from '../django-sync/runtime-error-reporter.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { logger } from '../utils/logger.js';

export interface ControlPlaneDeps {
    runtimeManager: RuntimeManager;
    runtimeConfigClient: RuntimeConfigClient;
    errorReporter: RuntimeErrorReporter;
}

export function createControlPlane(deps: ControlPlaneDeps): FastifyInstance {
    const app = Fastify({ logger: false });

    app.get('/health', async () => ({ success: true, status: 'ok' }));
    app.get('/ready', async (_request, reply) => {
        const status = deps.runtimeManager.status();
        if (status === 'running' || status === 'paused') {
            return { success: true, status };
        }
        return reply.code(503).send({ success: false, status });
    });

    app.post('/runtime/start', { preHandler: requireServiceToken }, async (request, reply) => {
        try {
            const payload = await resolveRuntimePayload(request.body, deps.runtimeConfigClient);
            if (!payload) {
                return reply.code(204).send();
            }
            logger.info('ControlPlane', `Received /runtime/start for runtime ${payload.runtime_config_id}.`);
            await deps.runtimeManager.start(payload);
            return { success: true, status: deps.runtimeManager.status() };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('ControlPlane', `/runtime/start failed: ${message}`);
            await deps.errorReporter.report('start', message);
            return reply.code(500).send({ success: false, detail: message });
        }
    });

    app.post('/runtime/stop', { preHandler: requireServiceToken }, async () => {
        logger.info('ControlPlane', 'Received /runtime/stop.');
        await deps.runtimeManager.stop();
        return { success: true, status: deps.runtimeManager.status() };
    });

    app.post('/runtime/pause', { preHandler: requireServiceToken }, async () => {
        deps.runtimeManager.pause();
        return { success: true, status: deps.runtimeManager.status() };
    });

    app.post('/runtime/resume', { preHandler: requireServiceToken }, async () => {
        deps.runtimeManager.resume();
        return { success: true, status: deps.runtimeManager.status() };
    });

    app.post('/runtime/test-trade', { preHandler: requireServiceToken }, async (request, reply) => {
        try {
            const payload = await resolveRuntimePayload(request.body, deps.runtimeConfigClient);
            if (!payload) {
                return reply.code(204).send();
            }
            const testTrade = typeof request.body === 'object' && request.body !== null && 'test_trade' in request.body
                ? (request.body as { test_trade?: unknown }).test_trade
                : {};
            return await deps.runtimeManager.runTestTrade(payload, typeof testTrade === 'object' && testTrade !== null ? testTrade : {});
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await deps.errorReporter.report('diagnostics', message);
            return reply.code(500).send({ success: false, detail: message });
        }
    });

    app.get('/runtime/state', { preHandler: requireServiceToken }, async () => deps.runtimeManager.state());
    app.get('/runtime/latency', { preHandler: requireServiceToken }, async () => ({
        metrics: deps.runtimeManager.latency(),
    }));

    app.post('/engine/trader/start', { preHandler: requireServiceToken }, async (request, reply) => {
        return startRuntime(request, reply, deps, 'start');
    });
    app.post('/engine/trader/sync', { preHandler: requireServiceToken }, async (request, reply) => {
        return startRuntime(request, reply, deps, 'sync');
    });
    app.post('/engine/trader/stop', { preHandler: requireServiceToken }, async (request, reply) => {
        const requestedRuntimeConfigId = parseRuntimeConfigId(request.body);
        const activeRuntimeConfigId = deps.runtimeManager.activeRuntimeConfigId();
        logger.info('ControlPlane', `Received /engine/trader/stop for runtime ${requestedRuntimeConfigId ?? 'unknown'}.`);
        if (
            requestedRuntimeConfigId !== undefined
            && activeRuntimeConfigId !== null
            && requestedRuntimeConfigId !== activeRuntimeConfigId
        ) {
            return reply.code(409).send({
                success: false,
                detail: `Stop requested for runtime ${requestedRuntimeConfigId}, but active runtime is ${activeRuntimeConfigId}.`,
            });
        }

        await deps.runtimeManager.stop();
        return { success: true, status: deps.runtimeManager.status() };
    });
    app.post('/engine/trader/runtime/exchange-health', { preHandler: requireServiceToken }, async (request, reply) => {
        try {
            const payload = await resolveRuntimePayload(request.body, deps.runtimeConfigClient);
            if (!payload) {
                return reply.code(204).send();
            }
            return deps.runtimeManager.checkExchangeHealth(payload);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await deps.errorReporter.report('exchange_health', message);
            return reply.code(500).send({ success: false, detail: message });
        }
    });
    app.get('/engine/trader/runtime/active-coins', { preHandler: requireServiceToken }, async request => {
        const diagnostics = deps.runtimeManager.getActiveTradesDiagnostics(parseRuntimeConfigId(request.query));
        return {
            requested_runtime_config_id: diagnostics.requested_runtime_config_id,
            active_runtime_config_id: diagnostics.active_runtime_config_id,
            is_requested_runtime_active: diagnostics.is_requested_runtime_active,
            trade_count: diagnostics.trade_count,
            active_coins: diagnostics.active_coins,
        };
    });
    app.get('/engine/trader/runtime/open-trades-pnl', { preHandler: requireServiceToken }, async request => {
        return deps.runtimeManager.getActiveTradesDiagnostics(parseRuntimeConfigId(request.query));
    });
    app.get('/engine/trader/runtime/system-load', { preHandler: requireServiceToken }, async request => {
        const runtimeState = deps.runtimeManager.getRuntimeDiagnosticsState();
        return {
            requested_runtime_config_id: parseRuntimeConfigId(request.query) ?? null,
            active_runtime_config_id: runtimeState.activeRuntimeConfigId,
            runtime_state: runtimeState.runtimeState,
            risk_locked: runtimeState.riskLocked,
            ...(await getSystemLoadSnapshot()),
        };
    });
    app.get('/engine/trader/runtime/server-info', { preHandler: requireServiceToken }, async request => {
        return getServerInfoSnapshot(parseRuntimeConfigId(request.query));
    });

    return app;
}

export async function requireServiceToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.headers['x-service-token'];
    if (token !== appConfig.serviceToken) {
        await reply.code(401).send({ detail: 'Invalid service token.' });
    }
}

async function resolveRuntimePayload(body: unknown, client: RuntimeConfigClient): Promise<RuntimeCommandPayload | null> {
    if (isRuntimeCommandPayload(body)) {
        return body;
    }

    if (typeof body === 'object' && body !== null && 'runtime_config_id' in body) {
        const id = Number((body as { runtime_config_id?: unknown }).runtime_config_id);
        if (Number.isInteger(id) && id > 0) {
            return client.fetchActivePayload(id);
        }
    }

    if (appConfig.traderInstanceId) {
        return client.fetchActivePayload(Number(appConfig.traderInstanceId));
    }

    throw new Error('Runtime payload or runtime_config_id is required.');
}

async function startRuntime(
    request: FastifyRequest,
    reply: FastifyReply,
    deps: ControlPlaneDeps,
    action: 'start' | 'sync',
): Promise<unknown> {
    try {
        const payload = await resolveRuntimePayload(request.body, deps.runtimeConfigClient);
        if (!payload) {
            return reply.code(204).send();
        }
        logger.info('ControlPlane', `Received /engine/trader/${action} for runtime ${payload.runtime_config_id}.`);
        await deps.runtimeManager.start(payload);
        return { success: true, status: deps.runtimeManager.status() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('ControlPlane', `/engine/trader/${action} failed: ${message}`);
        await deps.errorReporter.report('start', message);
        return reply.code(500).send({ success: false, detail: message });
    }
}

function parseRuntimeConfigId(value: unknown): number | undefined {
    if (typeof value !== 'object' || value === null || !('runtime_config_id' in value)) {
        return undefined;
    }

    const id = Number((value as { runtime_config_id?: unknown }).runtime_config_id);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}

async function getSystemLoadSnapshot(): Promise<{
    cpu_percent: number;
    memory_total_bytes: number;
    memory_used_bytes: number;
    memory_free_bytes: number;
    memory_used_percent: number;
}> {
    const start = cpuSnapshot();
    await new Promise(resolve => setTimeout(resolve, 250));
    const end = cpuSnapshot();
    const idleDelta = end.idle - start.idle;
    const totalDelta = end.total - start.total;
    const cpuPercent = totalDelta > 0 ? (1 - (idleDelta / totalDelta)) * 100 : 0;
    const memoryTotal = os.totalmem();
    const memoryFree = os.freemem();
    const memoryUsed = memoryTotal - memoryFree;
    const memoryUsedPercent = memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0;

    return {
        cpu_percent: round(cpuPercent),
        memory_total_bytes: memoryTotal,
        memory_used_bytes: memoryUsed,
        memory_free_bytes: memoryFree,
        memory_used_percent: round(memoryUsedPercent),
    };
}

function cpuSnapshot(): { idle: number; total: number } {
    return os.cpus().reduce((acc, cpu) => {
        const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
        return {
            idle: acc.idle + cpu.times.idle,
            total: acc.total + total,
        };
    }, { idle: 0, total: 0 });
}

function getServerInfoSnapshot(runtimeConfigId?: number): {
    requested_runtime_config_id: number | null;
    hostname: string;
    server_ip: string | null;
    ip_addresses: string[];
} {
    const addresses = Object.values(os.networkInterfaces())
        .flatMap(items => items ?? [])
        .filter(item => item.family === 'IPv4' && !item.internal)
        .map(item => item.address)
        .filter((address, index, items) => items.indexOf(address) === index);

    return {
        requested_runtime_config_id: runtimeConfigId ?? null,
        hostname: os.hostname(),
        server_ip: addresses[0] ?? null,
        ip_addresses: addresses,
    };
}

function round(value: number): number {
    return Number(value.toFixed(2));
}

function isRuntimeCommandPayload(value: unknown): value is RuntimeCommandPayload {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<RuntimeCommandPayload>;
    return typeof candidate.runtime_config_id === 'number'
        && typeof candidate.owner_id === 'number'
        && typeof candidate.config === 'object'
        && typeof candidate.keys === 'object';
}

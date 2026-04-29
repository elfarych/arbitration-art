import { appConfig } from './config.js';
import { createControlPlane } from './control-plane/server.js';
import { RuntimeConfigClient } from './django-sync/runtime-config-client.js';
import { RuntimeErrorReporter } from './django-sync/runtime-error-reporter.js';
import { RuntimeManager } from './runtime/runtime-manager.js';
import { logger } from './utils/logger.js';

const errorReporter = new RuntimeErrorReporter(appConfig.traderInstanceId ? Number(appConfig.traderInstanceId) : null);
const runtimeConfigClient = new RuntimeConfigClient(errorReporter);
const runtimeManager = new RuntimeManager(errorReporter);
const server = createControlPlane({ runtimeManager, runtimeConfigClient, errorReporter });

async function main(): Promise<void> {
    await server.listen({ host: '0.0.0.0', port: appConfig.port });
    logger.info('Main', `Control plane listening on ${appConfig.port}.`);

    if (appConfig.traderInstanceId) {
        const payload = await runtimeConfigClient.fetchActivePayload(Number(appConfig.traderInstanceId));
        if (payload) {
            await runtimeManager.start(payload);
        }
    }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(error => {
    logger.error('Main', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
    logger.info('Main', `Received ${signal}, stopping runtime.`);
    await runtimeManager.stop();
    await server.close();
}

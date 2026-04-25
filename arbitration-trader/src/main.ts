import { RuntimeManager } from './classes/RuntimeManager.js';
import { config } from './config.js';
import { createControlPlaneServer, type ControlPlaneServer } from './control-plane/server.js';
import { registerProcessShutdown } from './control-plane/shutdown.js';
import { api } from './services/api.js';
import { logger } from './utils/logger.js';

const TAG = 'MAIN';

async function main(): Promise<void> {
    const runtimeManager = new RuntimeManager();
    const serverRef: { current: ControlPlaneServer | null } = { current: null };

    registerProcessShutdown(runtimeManager, serverRef);

    const server = await createControlPlaneServer(runtimeManager);
    serverRef.current = server;
    await server.listen();
    await bootstrapConfiguredRuntime(runtimeManager);
}

async function bootstrapConfiguredRuntime(runtimeManager: RuntimeManager): Promise<void> {
    const runtimeConfigId = config.traderInstanceId;
    if (runtimeConfigId === null) {
        logger.info(TAG, 'TRADER_INSTANCE_ID is not configured. Waiting for Django lifecycle command.');
        return;
    }

    try {
        logger.info(TAG, `Fetching active runtime config ${runtimeConfigId} from Django.`);
        const payload = await api.getActiveRuntimePayload(runtimeConfigId);
        if (!payload) {
            logger.info(TAG, `Runtime config ${runtimeConfigId} is not active in Django. Trader control plane remains idle.`);
            return;
        }

        await runtimeManager.start(payload);
    } catch (error: any) {
        logger.error(TAG, `Failed to autostart runtime ${runtimeConfigId}: ${error.message}`);
        logger.error(TAG, error.stack || '');
        void api.createRuntimeConfigError({
            runtime_config: runtimeConfigId,
            error_type: 'start',
            error_text: `Autostart failed: ${error.message}`,
        });
    }
}

main().catch(error => {
    logger.error(TAG, `Failed to start trader control plane: ${error.message}`);
    logger.error(TAG, error.stack || '');
    process.exit(1);
});

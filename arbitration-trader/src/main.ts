import { RuntimeManager } from './classes/RuntimeManager.js';
import { createControlPlaneServer, type ControlPlaneServer } from './control-plane/server.js';
import { registerProcessShutdown } from './control-plane/shutdown.js';
import { logger } from './utils/logger.js';

const TAG = 'MAIN';

async function main(): Promise<void> {
    const runtimeManager = new RuntimeManager();
    const serverRef: { current: ControlPlaneServer | null } = { current: null };

    registerProcessShutdown(runtimeManager, serverRef);

    const server = await createControlPlaneServer(runtimeManager);
    serverRef.current = server;
    await server.listen();
}

main().catch(error => {
    logger.error(TAG, `Failed to start trader control plane: ${error.message}`);
    logger.error(TAG, error.stack || '');
    process.exit(1);
});

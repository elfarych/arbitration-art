import type { RuntimeManager } from '../classes/RuntimeManager.js';
import type { ControlPlaneServer } from './server.js';
import { logger } from '../utils/logger.js';

const TAG = 'Shutdown';

export function registerProcessShutdown(runtimeManager: RuntimeManager, serverRef: { current: ControlPlaneServer | null }): void {
    let isShuttingDown = false;

    const shutdown = async (exitCode: number) => {
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

        try {
            await serverRef.current?.close();
        } catch (error: any) {
            logger.error(TAG, `Control plane shutdown failed: ${error.message}`);
        }

        process.exit(exitCode);
    };

    process.on('SIGINT', () => {
        void shutdown(0);
    });

    process.on('SIGTERM', () => {
        void shutdown(0);
    });

    process.on('uncaughtException', error => {
        logger.error(TAG, `Uncaught exception: ${error.message}`);
        logger.error(TAG, error.stack || '');
        void shutdown(1);
    });

    process.on('unhandledRejection', reason => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        logger.error(TAG, `Unhandled rejection: ${error.message}`);
        logger.error(TAG, error.stack || '');
        void shutdown(1);
    });
}

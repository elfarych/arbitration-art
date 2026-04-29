import { appConfig, type RuntimeCommandPayload } from '../config.js';
import { RuntimeErrorReporter } from './runtime-error-reporter.js';

export class RuntimeConfigClient {
    constructor(private readonly errorReporter: RuntimeErrorReporter) {}

    async fetchActivePayload(runtimeConfigId: number): Promise<RuntimeCommandPayload | null> {
        const response = await fetch(`${appConfig.djangoApiUrl}/bots/runtime-configs/${runtimeConfigId}/active-payload/`, {
            headers: {
                'X-Service-Token': appConfig.serviceToken,
            },
        });

        if (response.status === 204) {
            return null;
        }
        if (!response.ok) {
            throw new Error(`Django active-payload failed with HTTP ${response.status}`);
        }

        const payload = await response.json() as RuntimeCommandPayload;
        this.errorReporter.setRuntimeFromPayload(payload);
        return payload;
    }

    async reportLifecycleStatus(_status: 'running' | 'paused' | 'stopped' | 'error'): Promise<void> {
        // Current Django runtime-config ViewSet is JWT-only for writes. The method
        // is kept as an integration point for a narrow service-token status API.
    }
}

import { appConfig, type RuntimeCommandPayload } from '../config.js';

export type RuntimeErrorType =
    | 'start'
    | 'sync'
    | 'stop'
    | 'runtime'
    | 'exchange_health'
    | 'diagnostics'
    | 'validation'
    | 'control_plane';

export class RuntimeErrorReporter {
    private readonly lastReportAt = new Map<string, number>();

    constructor(private runtimeConfigId: number | null = null) {}

    setRuntimeConfigId(runtimeConfigId: number | null): void {
        this.runtimeConfigId = runtimeConfigId;
    }

    setRuntimeFromPayload(payload: RuntimeCommandPayload): void {
        this.runtimeConfigId = payload.runtime_config_id;
    }

    async report(errorType: RuntimeErrorType, errorText: string): Promise<void> {
        if (!this.runtimeConfigId) {
            return;
        }

        const sanitized = sanitizeErrorText(errorText);
        const key = `${errorType}:${sanitized}`;
        const now = Date.now();
        const last = this.lastReportAt.get(key) ?? 0;
        if (now - last < appConfig.errorReportThrottleMs) {
            return;
        }
        this.lastReportAt.set(key, now);

        await fetch(`${appConfig.djangoApiUrl}/bots/runtime-config-errors/`, {
            method: 'POST',
            body: JSON.stringify({
                runtime_config: this.runtimeConfigId,
                error_type: errorType,
                error_text: sanitized,
            }),
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': appConfig.serviceToken,
            },
        }).catch(() => undefined);
    }
}

export function sanitizeErrorText(text: string): string {
    return text
        .replace(/(api[_-]?key|secret|token|signature)=([^&\s]+)/gi, '$1=[redacted]')
        .replace(/"?(api[_-]?key|secret|token|signature)"?\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
        .slice(0, 2000);
}

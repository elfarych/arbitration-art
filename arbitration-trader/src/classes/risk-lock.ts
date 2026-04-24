export interface RuntimeRiskIncident {
    key: string;
    reason: string;
    details: string;
    lockedAt: string;
    updatedAt: string;
    count: number;
}

export interface RuntimeRiskLockStatus {
    isLocked: boolean;
    incidents: RuntimeRiskIncident[];
}

interface MutableRuntimeRiskIncident {
    key: string;
    reason: string;
    details: string;
    lockedAtMs: number;
    updatedAtMs: number;
    count: number;
}

export class RuntimeRiskLock {
    private incidents = new Map<string, MutableRuntimeRiskIncident>();

    get isLocked(): boolean {
        return this.incidents.size > 0;
    }

    lock(key: string, reason: string, details: string): void {
        const now = Date.now();
        const existing = this.incidents.get(key);
        if (existing) {
            existing.reason = reason;
            existing.details = details;
            existing.updatedAtMs = now;
            existing.count += 1;
            return;
        }

        this.incidents.set(key, {
            key,
            reason,
            details,
            lockedAtMs: now,
            updatedAtMs: now,
            count: 1,
        });
    }

    clear(key: string): void {
        this.incidents.delete(key);
    }

    getStatus(): RuntimeRiskLockStatus {
        return {
            isLocked: this.isLocked,
            incidents: [...this.incidents.values()].map(incident => ({
                key: incident.key,
                reason: incident.reason,
                details: incident.details,
                lockedAt: new Date(incident.lockedAtMs).toISOString(),
                updatedAt: new Date(incident.updatedAtMs).toISOString(),
                count: incident.count,
            })),
        };
    }
}

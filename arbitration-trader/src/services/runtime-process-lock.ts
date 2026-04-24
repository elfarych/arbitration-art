import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';

interface RuntimeLockMetadata {
    pid: number;
    runtime_config_id: number;
    owner_id: number;
    environment: string;
    account_fingerprint: string;
    created_at: string;
}

/**
 * Host-local lock that prevents two trader processes in the same deployment
 * directory from starting against the same runtime/account by accident.
 */
export class RuntimeProcessLock {
    private lockPath: string | null = null;
    private lockContent: string | null = null;

    async acquire(metadata: Omit<RuntimeLockMetadata, 'pid' | 'created_at' | 'environment'>): Promise<void> {
        if (this.lockPath) {
            throw new Error(`Runtime process lock is already held by this process: ${this.lockPath}`);
        }

        const lockPath = config.processLockPath;
        const content = JSON.stringify({
            ...metadata,
            pid: process.pid,
            environment: config.traderEnvironment,
            created_at: new Date().toISOString(),
        } satisfies RuntimeLockMetadata, null, 2);

        await mkdir(dirname(lockPath), { recursive: true });

        try {
            const handle = await open(lockPath, 'wx');
            try {
                await handle.writeFile(content, 'utf8');
            } finally {
                await handle.close();
            }
        } catch (error: any) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }

            const existing = await readExistingLock(lockPath);
            throw new Error(
                `Runtime process lock already exists at ${lockPath}. `
                + `Verify exchange exposure before removing it manually. Existing lock: ${existing}`,
            );
        }

        this.lockPath = lockPath;
        this.lockContent = content;
    }

    async release(): Promise<void> {
        if (!this.lockPath) {
            return;
        }

        const path = this.lockPath;
        const expected = this.lockContent;
        this.lockPath = null;
        this.lockContent = null;

        try {
            const current = await readFile(path, 'utf8');
            if (expected !== null && current !== expected) {
                throw new Error(`Runtime process lock at ${path} changed ownership; refusing to remove it.`);
            }

            await rm(path, { force: true });
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return;
            }
            throw error;
        }
    }
}

async function readExistingLock(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return '<unreadable>';
    }
}

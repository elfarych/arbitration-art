import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';

export class AsyncEventWriter {
    private readonly queue: unknown[] = [];
    private processing = false;
    private stopped = false;

    constructor(private readonly filePath: string) {}

    enqueue(event: unknown): void {
        this.queue.push(event);
        this.kick();
    }

    stop(): void {
        this.stopped = true;
    }

    async flushForTests(maxIterations = 50): Promise<void> {
        let iterations = 0;
        while ((this.queue.length > 0 || this.processing) && iterations < maxIterations) {
            await sleep(10);
            iterations += 1;
        }
    }

    private kick(): void {
        if (this.processing || this.stopped) {
            return;
        }
        this.processing = true;
        void this.processLoop();
    }

    private async processLoop(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        while (!this.stopped && this.queue.length > 0) {
            const event = this.queue.shift();
            try {
                await appendFile(this.filePath, `${JSON.stringify({ ts: new Date().toISOString(), event })}\n`, 'utf8');
            } catch (error) {
                logger.warn('AsyncEventWriter', `Failed to write event: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.processing = false;
        if (!this.stopped && this.queue.length > 0) {
            this.kick();
        }
    }
}

export class CompositeEventWriter {
    constructor(private readonly writers: AsyncEventWriter[]) {}

    enqueue(event: unknown): void {
        for (const writer of this.writers) {
            writer.enqueue(event);
        }
    }

    stop(): void {
        for (const writer of this.writers) {
            writer.stop();
        }
    }
}

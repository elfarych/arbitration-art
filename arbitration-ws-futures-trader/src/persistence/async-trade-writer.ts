import type { NormalizedRuntimeConfig } from '../config.js';
import type { ActiveTrade, ClosedTrade } from '../execution/trade-state.js';
import { RuntimeErrorReporter } from '../django-sync/runtime-error-reporter.js';
import { TradeSyncService } from '../django-sync/trade-sync-service.js';
import { sleep } from '../utils/http.js';
import { logger } from '../utils/logger.js';

type QueueItem =
    | { type: 'open'; activeTrade: ActiveTrade }
    | { type: 'close'; closedTrade: ClosedTrade; onPersisted?: () => void };

export class AsyncTradeWriter {
    private readonly queue: QueueItem[] = [];
    private processing = false;
    private stopped = false;
    private readonly localToDjangoId = new Map<string, number>();

    constructor(
        private readonly runtime: NormalizedRuntimeConfig,
        private readonly syncService: TradeSyncService,
        private readonly errorReporter: RuntimeErrorReporter,
        private readonly retryDelayMs: number,
    ) {}

    enqueueOpen(activeTrade: ActiveTrade): void {
        this.queue.push({ type: 'open', activeTrade });
        this.kick();
    }

    enqueueClose(closedTrade: ClosedTrade, onPersisted?: () => void): void {
        this.queue.push({ type: 'close', closedTrade, onPersisted });
        this.kick();
    }

    size(): number {
        return this.queue.length;
    }

    async flushForTests(maxIterations = 50): Promise<void> {
        let iterations = 0;
        while ((this.queue.length > 0 || this.processing) && iterations < maxIterations) {
            await sleep(10);
            iterations += 1;
        }
    }

    stop(): void {
        this.stopped = true;
    }

    private kick(): void {
        if (this.processing || this.stopped) {
            return;
        }
        this.processing = true;
        void this.processLoop();
    }

    private async processLoop(): Promise<void> {
        while (!this.stopped && this.queue.length > 0) {
            const item = this.queue[0];
            try {
                if (item.type === 'open') {
                    await this.processOpen(item.activeTrade);
                } else {
                    await this.processClose(item.closedTrade);
                    try {
                        item.onPersisted?.();
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        logger.warn('AsyncTradeWriter', `Close persistence callback failed: ${message}`);
                    }
                }
                this.queue.shift();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('AsyncTradeWriter', `Django sync retry scheduled: ${message}`);
                await this.errorReporter.report('runtime', `Django trade sync failed: ${message}`);
                await sleep(this.retryDelayMs);
            }
        }
        this.processing = false;
        if (!this.stopped && this.queue.length > 0) {
            this.kick();
        }
    }

    private async processOpen(activeTrade: ActiveTrade): Promise<void> {
        if (this.localToDjangoId.has(activeTrade.localTradeId)) {
            return;
        }
        const record = await this.syncService.createOpenTrade(activeTrade, this.runtime.leverage);
        this.localToDjangoId.set(activeTrade.localTradeId, record.id);
        activeTrade.djangoTradeId = record.id;
    }

    private async processClose(closedTrade: ClosedTrade): Promise<void> {
        let djangoId = this.localToDjangoId.get(closedTrade.activeTrade.localTradeId) ?? closedTrade.activeTrade.djangoTradeId;
        if (!djangoId) {
            const record = await this.syncService.createOpenTrade(closedTrade.activeTrade, this.runtime.leverage);
            djangoId = record.id;
            this.localToDjangoId.set(closedTrade.activeTrade.localTradeId, djangoId);
            closedTrade.activeTrade.djangoTradeId = djangoId;
        }
        await this.syncService.closeTrade(djangoId, closedTrade);
    }
}

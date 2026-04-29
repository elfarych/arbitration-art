import type { ExchangePosition, PositionReader } from '../exchanges/exchange-types.js';
import { RuntimeErrorReporter } from '../django-sync/runtime-error-reporter.js';
import { AsyncEventWriter, CompositeEventWriter } from '../persistence/async-event-writer.js';
import { logger } from '../utils/logger.js';

export class BackgroundReconciliation {
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly readers: PositionReader[],
        private readonly symbols: string[],
        private readonly eventWriter: AsyncEventWriter | CompositeEventWriter,
        private readonly errorReporter: RuntimeErrorReporter,
        private readonly intervalMs = 30_000,
    ) {}

    start(): void {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => {
            void this.runOnce();
        }, this.intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }

    async runOnce(): Promise<ExchangePosition[]> {
        const allPositions: ExchangePosition[] = [];
        for (const reader of this.readers) {
            try {
                allPositions.push(...await reader.fetchOpenPositions(this.symbols));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('BackgroundReconciliation', `${reader.exchange} reconciliation failed: ${message}`);
                await this.errorReporter.report('runtime', `${reader.exchange} reconciliation failed: ${message}`);
            }
        }

        this.eventWriter.enqueue({
            type: 'background_reconciliation',
            positions: allPositions,
        });
        return allPositions;
    }
}

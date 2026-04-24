import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Shared counter for concurrent trades across all Trader instances.
 * Implements optimistic reservation to prevent async open races.
 */
export class TradeCounter {
    private count = 0;

    get current(): number {
        return this.count;
    }

    canOpen(): boolean {
        return this.count < config.maxConcurrentTrades;
    }

    reserve(): boolean {
        if (this.count < config.maxConcurrentTrades) {
            this.count++;
            logger.info('TradeCounter', `Reserved trade slot: ${this.count}/${config.maxConcurrentTrades}`);
            return true;
        }

        return false;
    }

    release(): void {
        this.count = Math.max(0, this.count - 1);
        logger.info('TradeCounter', `Released trade slot: ${this.count}/${config.maxConcurrentTrades}`);
    }

    forceReserve(): void {
        this.count++;
        logger.info('TradeCounter', `Force reserved (restore): ${this.count}/${config.maxConcurrentTrades}`);
    }
}

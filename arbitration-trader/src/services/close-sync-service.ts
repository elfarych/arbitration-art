import { api } from './api.js';
import type { TradeClosePayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

const CLOSE_SYNC_RETRIES = 10;
const CLOSE_SYNC_RETRY_DELAY_MS = 5000;

export class CloseSyncService {
    constructor(private readonly tag: string) {}

    async persistCloseTrade(tradeId: number, payload: TradeClosePayload): Promise<boolean> {
        for (let attempt = 1; attempt <= CLOSE_SYNC_RETRIES; attempt++) {
            try {
                await api.closeTrade(tradeId, payload);
                return true;
            } catch (error: any) {
                logger.error(
                    this.tag,
                    `❌ CRITICAL: Django update failed (ID: ${tradeId}): ${error.message}. Attempt ${attempt}/${CLOSE_SYNC_RETRIES}.`,
                );

                if (attempt < CLOSE_SYNC_RETRIES) {
                    await sleep(CLOSE_SYNC_RETRY_DELAY_MS);
                }
            }
        }

        return false;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

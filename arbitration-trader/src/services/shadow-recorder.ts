import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import type { OrderbookPrices } from '../types/index.js';
import { logger } from '../utils/logger.js';

interface ShadowEntrySignal {
    runtime_config_id: number;
    symbol: string;
    order_type: 'buy' | 'sell';
    amount: number;
    spread: number;
    expected_net_edge: number;
    funding_cost_percent: number;
    prices: OrderbookPrices;
    created_at: string;
}

class ShadowRecorder {
    async recordEntrySignal(payload: Omit<ShadowEntrySignal, 'runtime_config_id' | 'created_at'>): Promise<void> {
        const fullPayload: ShadowEntrySignal = {
            runtime_config_id: config.runtimeConfigId,
            created_at: new Date().toISOString(),
            ...payload,
        };

        const path = resolve(process.cwd(), config.shadowSignalLogPath);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(fullPayload)}\n`, 'utf8');
        logger.info('ShadowRecorder', `Recorded shadow signal for ${payload.symbol} (${payload.order_type})`);
    }
}

export const shadowRecorder = new ShadowRecorder();

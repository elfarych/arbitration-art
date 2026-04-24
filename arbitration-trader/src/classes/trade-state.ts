import type { TradeClosePayload, TradeRecord } from '../types/index.js';

export type CloseTriggerReason = 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation';

export interface PendingCloseSync {
    payload: TradeClosePayload;
    reason: CloseTriggerReason;
    nextBaselineBuy: number | null;
    nextBaselineSell: number | null;
}

/**
 * Per-symbol mutable runtime state.
 *
 * Django is the durable source for trade records. This state controls signal
 * calculation, cooldowns, re-entrancy protection and pending close syncs inside
 * the current process only.
 */
export interface PairState {
    baselineBuy: number | null;
    baselineSell: number | null;
    activeTrade: TradeRecord | null;
    openedAtMs: number | null;
    busy: boolean;
    cooldownUntil: number;
    pendingCloseSync: PendingCloseSync | null;
    canOpenNewTrades: boolean;
}

export function createPairState(canOpenNewTrades: boolean): PairState {
    return {
        baselineBuy: null,
        baselineSell: null,
        activeTrade: null,
        openedAtMs: null,
        busy: false,
        cooldownUntil: 0,
        pendingCloseSync: null,
        canOpenNewTrades,
    };
}

import type { TradeClosePayload, TradeRecord } from '../types/index.js';

export type CloseTriggerReason = 'profit' | 'timeout' | 'shutdown' | 'error' | 'liquidation';

export interface PendingCloseSync {
    intentId: string;
    payload: TradeClosePayload;
    reason: CloseTriggerReason;
    nextBaselineBuy: number | null;
    nextBaselineSell: number | null;
}

export interface UnmanagedExposureState {
    orderType: 'buy' | 'sell';
    slotReserved: boolean;
    cleanupAttempts: number;
    lastError: string;
    lockedAtMs: number;
    nextRetryAtMs: number;
}

export interface CloseLegState {
    price: number;
    orderId: string;
    commission: number;
    size: number;
    closedAt: string;
}

export interface PartialCloseState {
    primary?: CloseLegState;
    secondary?: CloseLegState;
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
    unmanagedExposure: UnmanagedExposureState | null;
    partialClose: PartialCloseState;
    closeIntentId: string | null;
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
        unmanagedExposure: null,
        partialClose: {},
        closeIntentId: null,
        canOpenNewTrades,
    };
}

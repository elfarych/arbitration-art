import type { SymbolStateStatus } from '../exchanges/exchange-types.js';
import type { ActiveTrade } from '../execution/trade-state.js';

export interface SymbolSignalState {
    symbol: string;
    status: SymbolStateStatus;
    baselineBuy: number | null;
    baselineSell: number | null;
    activeTrade: ActiveTrade | null;
    pendingRerun: boolean;
    lastError: string | null;
}

export function createSymbolSignalState(symbol: string): SymbolSignalState {
    return {
        symbol,
        status: 'idle',
        baselineBuy: null,
        baselineSell: null,
        activeTrade: null,
        pendingRerun: false,
        lastError: null,
    };
}

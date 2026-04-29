import type { ExchangeName } from '../config.js';
import type { OrderExecution, SymbolStateStatus, TradeDirection } from '../exchanges/exchange-types.js';

export interface ActiveTrade {
    localTradeId: string;
    djangoTradeId: number | null;
    runtimeConfigId: number;
    symbol: string;
    direction: TradeDirection;
    quantity: number;
    primaryExchange: ExchangeName;
    secondaryExchange: ExchangeName;
    primaryOpenPrice: number;
    secondaryOpenPrice: number;
    primaryOpenOrderId: string;
    secondaryOpenOrderId: string;
    openSpread: number;
    openCommission: number;
    openedAt: string;
    openExecutions: {
        primary: OrderExecution;
        secondary: OrderExecution;
    };
}

export interface ClosedTrade {
    activeTrade: ActiveTrade;
    primaryCloseExecution: OrderExecution;
    secondaryCloseExecution: OrderExecution;
    primaryClosePrice: number;
    secondaryClosePrice: number;
    closeSpread: number;
    closeCommission: number;
    profitUsdt: number;
    profitPercentage: number;
    closeReason: 'profit' | 'timeout' | 'shutdown' | 'error';
    closedAt: string;
}

export class TradeCounter {
    private active = 0;

    constructor(private readonly limit: number) {}

    tryReserve(): boolean {
        if (this.active >= this.limit) {
            return false;
        }
        this.active += 1;
        return true;
    }

    release(): void {
        this.active = Math.max(0, this.active - 1);
    }

    value(): number {
        return this.active;
    }
}

export class SymbolStateMachine {
    private statusValue: SymbolStateStatus = 'idle';

    status(): SymbolStateStatus {
        return this.statusValue;
    }

    tryStartOpen(): boolean {
        if (this.statusValue !== 'idle') {
            return false;
        }
        this.statusValue = 'opening';
        return true;
    }

    markOpen(): void {
        this.require('opening');
        this.statusValue = 'open';
    }

    tryStartClose(): boolean {
        if (this.statusValue !== 'open') {
            return false;
        }
        this.statusValue = 'closing';
        return true;
    }

    markClosePendingPersistence(): void {
        this.require('closing');
        this.statusValue = 'close_pending_persistence';
    }

    markIdle(): void {
        this.statusValue = 'idle';
    }

    markPaused(): void {
        this.statusValue = 'paused';
    }

    markErrorExposure(): void {
        this.statusValue = 'error_exposure';
    }

    private require(expected: SymbolStateStatus): void {
        if (this.statusValue !== expected) {
            throw new Error(`Invalid symbol state transition ${this.statusValue} -> expected ${expected}`);
        }
    }
}

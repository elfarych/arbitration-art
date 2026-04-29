import type { NormalizedRuntimeConfig } from '../config.js';
import type { ActiveTrade } from '../execution/trade-state.js';
import type { OrderbookPrices } from '../utils/math.js';
import { calculateRealPnL, calculateTruePnL } from '../utils/math.js';

export interface CloseSignal {
    reason: 'profit' | 'timeout';
    currentPnlPercent: number;
}

export class PnlEngine {
    constructor(private readonly runtime: NormalizedRuntimeConfig) {}

    evaluateClose(activeTrade: ActiveTrade, prices: OrderbookPrices | null, now = Date.now()): CloseSignal | null {
        if (prices) {
            const currentPnlPercent = calculateTruePnL(
                {
                    pOpen: activeTrade.primaryOpenPrice,
                    sOpen: activeTrade.secondaryOpenPrice,
                },
                prices,
                activeTrade.direction,
            );

            if (currentPnlPercent >= this.runtime.closeThreshold) {
                return { reason: 'profit', currentPnlPercent };
            }
        }

        const openedAtMs = Date.parse(activeTrade.openedAt);
        if (Number.isFinite(openedAtMs) && now - openedAtMs >= this.runtime.maxTradeDurationMs) {
            return { reason: 'timeout', currentPnlPercent: prices ? calculateTruePnL(
                {
                    pOpen: activeTrade.primaryOpenPrice,
                    sOpen: activeTrade.secondaryOpenPrice,
                },
                prices,
                activeTrade.direction,
            ) : 0 };
        }

        return null;
    }

    calculateFinalPnl(activeTrade: ActiveTrade, close: { primaryPrice: number; secondaryPrice: number; commission: number }) {
        return calculateRealPnL(
            activeTrade.primaryOpenPrice,
            activeTrade.secondaryOpenPrice,
            close.primaryPrice,
            close.secondaryPrice,
            activeTrade.quantity,
            activeTrade.direction,
            activeTrade.openCommission + close.commission,
        );
    }
}

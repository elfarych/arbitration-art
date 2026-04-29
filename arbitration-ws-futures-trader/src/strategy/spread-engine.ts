import type { NormalizedRuntimeConfig } from '../config.js';
import type { TradeDirection, UnifiedMarketInfo } from '../exchanges/exchange-types.js';
import type { OrderbookPrices } from '../utils/math.js';
import { calculateOpenSpread } from '../utils/math.js';

const EMA_ALPHA = 0.002;

export interface EntrySignal {
    direction: TradeDirection;
    spread: number;
    expectedNetEdge: number;
}

export interface SpreadEvaluation {
    nextBaselineBuy: number;
    nextBaselineSell: number;
    signal: EntrySignal | null;
}

export class SpreadEngine {
    constructor(private readonly runtime: NormalizedRuntimeConfig) {}

    evaluate(
        prices: OrderbookPrices,
        marketInfo: UnifiedMarketInfo,
        baselineBuy: number | null,
        baselineSell: number | null,
    ): SpreadEvaluation {
        const buySpread = calculateOpenSpread(prices, 'buy');
        const sellSpread = calculateOpenSpread(prices, 'sell');
        const nextBaselineBuy = this.updateBaseline(baselineBuy, buySpread);
        const nextBaselineSell = this.updateBaseline(baselineSell, sellSpread);

        const buySignal = this.buildSignal('buy', buySpread, nextBaselineBuy, marketInfo);
        if (buySignal) {
            return { nextBaselineBuy, nextBaselineSell, signal: buySignal };
        }

        const sellSignal = this.buildSignal('sell', sellSpread, nextBaselineSell, marketInfo);
        return { nextBaselineBuy, nextBaselineSell, signal: sellSignal };
    }

    private updateBaseline(previous: number | null, current: number): number {
        if (previous === null) {
            return current;
        }
        return previous * (1 - EMA_ALPHA) + current * EMA_ALPHA;
    }

    private buildSignal(
        direction: TradeDirection,
        spread: number,
        baseline: number,
        marketInfo: UnifiedMarketInfo,
    ): EntrySignal | null {
        if (!Number.isFinite(spread) || !Number.isFinite(baseline)) {
            return null;
        }
        if (spread < baseline + this.runtime.openThreshold) {
            return null;
        }

        const expectedNetEdge = spread - 0.20 - 0.05 - 0.02;
        if (expectedNetEdge <= 0 || marketInfo.tradeAmount <= 0) {
            return null;
        }

        return { direction, spread, expectedNetEdge };
    }
}

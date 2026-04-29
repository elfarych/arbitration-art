import { config } from '../config.js';
import type { OrderbookPrices, UnifiedMarketInfo } from '../types/index.js';
import { calculateOpenSpread } from '../utils/math.js';

const EMA_ALPHA = 0.002;

export interface EntrySignalDecision {
    orderType: 'buy' | 'sell';
    spread: number;
    expectedNetEdge: number;
    fundingCostPercent: number;
}

export interface EntrySignalEvaluation {
    nextBaselineBuy: number;
    nextBaselineSell: number;
    decision: EntrySignalDecision | null;
}

export class SignalEngine {
    evaluateEntry(
        prices: OrderbookPrices,
        marketInfo: UnifiedMarketInfo,
        baselineBuy: number | null,
        baselineSell: number | null,
    ): EntrySignalEvaluation {
        const currentBuySpread = calculateOpenSpread(prices, 'buy');
        const currentSellSpread = calculateOpenSpread(prices, 'sell');
        const nextBaselineBuy = this.updateBaseline(baselineBuy, currentBuySpread);
        const nextBaselineSell = this.updateBaseline(baselineSell, currentSellSpread);

        const buyDecision = this.buildDecision('buy', currentBuySpread, nextBaselineBuy, marketInfo);
        if (buyDecision) {
            return { nextBaselineBuy, nextBaselineSell, decision: buyDecision };
        }

        const sellDecision = this.buildDecision('sell', currentSellSpread, nextBaselineSell, marketInfo);
        if (sellDecision) {
            return { nextBaselineBuy, nextBaselineSell, decision: sellDecision };
        }

        return { nextBaselineBuy, nextBaselineSell, decision: null };
    }

    evaluateEntryRecheck(
        orderType: 'buy' | 'sell',
        prices: OrderbookPrices,
        marketInfo: UnifiedMarketInfo,
    ): EntrySignalDecision | null {
        const spread = calculateOpenSpread(prices, orderType);
        return this.buildNetEdgeDecision(orderType, spread, marketInfo);
    }

    private updateBaseline(previous: number | null, current: number): number {
        if (previous === null) {
            return current;
        }

        return previous * (1 - EMA_ALPHA) + current * EMA_ALPHA;
    }

    private buildDecision(
        orderType: 'buy' | 'sell',
        spread: number,
        baseline: number,
        marketInfo: UnifiedMarketInfo,
    ): EntrySignalDecision | null {
        if (spread < baseline + config.openThreshold) {
            return null;
        }

        return this.buildNetEdgeDecision(orderType, spread, marketInfo);
    }

    private buildNetEdgeDecision(
        orderType: 'buy' | 'sell',
        spread: number,
        marketInfo: UnifiedMarketInfo,
    ): EntrySignalDecision | null {
        const fundingCostPercent = this.estimateFundingCostPercent(orderType, marketInfo);
        const expectedNetEdge = spread
            - config.entryFeeBufferPercent
            - config.entrySlippageBufferPercent
            - config.latencyBufferPercent
            - fundingCostPercent
            - config.fundingBufferPercent;

        if (expectedNetEdge < config.minOpenNetEdgePercent) {
            return null;
        }

        return {
            orderType,
            spread,
            expectedNetEdge,
            fundingCostPercent,
        };
    }

    private estimateFundingCostPercent(orderType: 'buy' | 'sell', marketInfo: UnifiedMarketInfo): number {
        const primaryRate = this.ratePercentIfDue(marketInfo.primaryFundingRate, marketInfo.primaryNextFundingTime);
        const secondaryRate = this.ratePercentIfDue(marketInfo.secondaryFundingRate, marketInfo.secondaryNextFundingTime);

        const primaryCost = orderType === 'buy' ? primaryRate : -primaryRate;
        const secondaryCost = orderType === 'buy' ? -secondaryRate : secondaryRate;

        return Math.max(0, primaryCost + secondaryCost);
    }

    private ratePercentIfDue(rate: number | null, nextFundingTime: number | null): number {
        if (rate === null || !Number.isFinite(rate)) {
            return 0;
        }

        if (nextFundingTime !== null && Number.isFinite(nextFundingTime)) {
            const msUntilFunding = nextFundingTime - Date.now();
            if (msUntilFunding > config.maxTradeDurationMs) {
                return 0;
            }
        }

        return rate * 100;
    }
}

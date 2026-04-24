import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { ExchangeTicker, UnifiedMarketInfo } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { commonDecimalStep, roundDownToStep } from '../utils/math.js';

const TAG = 'MarketInfo';

/**
 * Pre-loads and caches unified market info for all tradeable symbols.
 * Called ONCE at bootstrap — never during trade execution.
 *
 * The service merges both exchanges' constraints and keeps the strictest values
 * so the same trade amount should be valid on both legs.
 */
export class MarketInfoService {
    private cache: Map<string, UnifiedMarketInfo> = new Map();

    /**
     * Initialize market info for all common symbols.
     * Calculates the unified trade amount (identical for both exchanges).
     * @returns Array of symbols that are tradeable on both exchanges.
     */
    async initialize(
        primaryClient: IExchangeClient,
        secondaryClient: IExchangeClient,
        commonSymbols: string[],
    ): Promise<string[]> {
        logger.info(TAG, `Initializing market info for ${commonSymbols.length} symbols...`);

        // Fetch current prices to calculate static trade amounts and protect from
        // ticker collisions where two exchanges list different assets under the
        // same symbol.
        let currentPrices: Record<string, number> = {};
        let secondaryPrices: Record<string, number> = {};
        let primaryTickers: Record<string, ExchangeTicker> = {};
        let secondaryTickers: Record<string, ExchangeTicker> = {};
        try {
            logger.info(TAG, `Fetching current prices for amount calculation and collision protection...`);
            const [pTickers, sTickers] = await Promise.all([
                primaryClient.fetchTickers(),
                secondaryClient.fetchTickers()
            ]);
            primaryTickers = pTickers;
            secondaryTickers = sTickers;
            for (const sym of commonSymbols) {
                if (pTickers[sym]?.last) currentPrices[sym] = pTickers[sym].last;
                if (sTickers[sym]?.last) secondaryPrices[sym] = sTickers[sym].last;
            }
        } catch (e: any) {
            logger.warn(TAG, `Could not fetch tickers for exact amounts/collisions: ${e.message}`);
        }

        const tradeableSymbols: string[] = [];

        for (const symbol of commonSymbols) {
            const primaryInfo = primaryClient.getMarketInfo(symbol);
            const secondaryInfo = secondaryClient.getMarketInfo(symbol);

            if (!primaryInfo || !secondaryInfo) {
                logger.debug(TAG, `Skipping ${symbol}: missing market info on one exchange`);
                continue;
            }

            // Use a lot step that is valid for both exchanges, including
            // non-power-of-ten increments such as 0.0005 or non-divisible steps.
            const stepSize = commonDecimalStep(primaryInfo.stepSize, secondaryInfo.stepSize);
            const minQty = Math.max(primaryInfo.minQty, secondaryInfo.minQty);
            const minNotional = Math.max(primaryInfo.minNotional, secondaryInfo.minNotional);

            let tradeAmount = 0;
            const currentPrice = currentPrices[symbol];
            const secondaryPrice = secondaryPrices[symbol];

            // ==== Homonym / Ticker Collision Protection ====
            if (currentPrice && secondaryPrice) {
                // A very large cross-exchange price deviation usually means this
                // is not the same underlying asset, even if the ticker matches.
                const deviation = Math.abs(currentPrice - secondaryPrice) / Math.min(currentPrice, secondaryPrice);
                if (deviation > 0.40) {
                    logger.warn(TAG, `🚨 HOMONYM DETECTED: Skipping ${symbol}. Deviation: ${(deviation * 100).toFixed(0)}%. (${primaryClient.name}: ${currentPrice}, ${secondaryClient.name}: ${secondaryPrice})`);
                    continue;
                }
            } else if (!currentPrice) {
                logger.debug(TAG, `Skipping ${symbol}: could not determine current price on ${primaryClient.name}`);
                continue;
            }

            if (currentPrice) {
                // Convert configured USDT budget into base-coin amount and then
                // round down to a lot size that is valid on both exchanges.
                const rawAmount = config.tradeAmountUsdt / currentPrice;
                tradeAmount = roundDownToStep(rawAmount, stepSize);
                
                // Validate against both quantity and notional minimums.
                const notionalValue = tradeAmount * currentPrice;
                if (tradeAmount < minQty || notionalValue < minNotional) {
                    logger.debug(TAG, `Skipping ${symbol}: calculated amount ${tradeAmount} does not meet minimums. (${tradeAmount} < ${minQty} or ${notionalValue} < ${minNotional})`);
                    continue;
                }
            }

            const unified: UnifiedMarketInfo = {
                symbol,
                stepSize,
                minQty,
                minNotional,
                tradeAmount,
                primaryFundingRate: primaryTickers[symbol]?.fundingRate ?? null,
                secondaryFundingRate: secondaryTickers[symbol]?.fundingRate ?? null,
                primaryNextFundingTime: primaryTickers[symbol]?.nextFundingTime ?? null,
                secondaryNextFundingTime: secondaryTickers[symbol]?.nextFundingTime ?? null,
                tradeable: true,
            };

            this.cache.set(symbol, unified);
            tradeableSymbols.push(symbol);
        }

        logger.info(TAG, `Tradeable symbols: ${tradeableSymbols.length}/${commonSymbols.length}`);
        return tradeableSymbols;
    }

    /**
     * Get cached market info for a symbol.
     */
    getInfo(symbol: string): UnifiedMarketInfo | undefined {
        return this.cache.get(symbol);
    }
}

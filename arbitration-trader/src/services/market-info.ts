import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { UnifiedMarketInfo } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const TAG = 'MarketInfo';

/**
 * Pre-loads and caches unified market info for all tradeable symbols.
 * Called ONCE at bootstrap — never during trade execution.
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

        // Fetch current prices to calculate static trade amounts and protect from ticker collisions
        let currentPrices: Record<string, number> = {};
        let secondaryPrices: Record<string, number> = {};
        try {
            logger.info(TAG, `Fetching current prices for amount calculation and collision protection...`);
            const [pTickers, sTickers] = await Promise.all([
                primaryClient.ccxtInstance.fetchTickers(),
                secondaryClient.ccxtInstance.fetchTickers()
            ]);
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

            // Use the strictest constraints from both exchanges
            const stepSize = Math.max(primaryInfo.stepSize, secondaryInfo.stepSize);
            const minQty = Math.max(primaryInfo.minQty, secondaryInfo.minQty);
            const minNotional = Math.max(primaryInfo.minNotional, secondaryInfo.minNotional);

            let tradeAmount = 0;
            const currentPrice = currentPrices[symbol];
            const secondaryPrice = secondaryPrices[symbol];

            // ==== Homonym / Ticker Collision Protection ====
            if (currentPrice && secondaryPrice) {
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
                const rawAmount = config.tradeAmountUsdt / currentPrice;
                // Round DOWN to step size
                tradeAmount = Math.floor(rawAmount / stepSize) * stepSize;
                
                // Validate against minimums
                const notionalValue = tradeAmount * currentPrice;
                if (tradeAmount < minQty || notionalValue < minNotional) {
                    logger.debug(TAG, `Skipping ${symbol}: calculated amount ${tradeAmount} does not meet minimums. (${tradeAmount} < ${minQty} or ${notionalValue} < ${minNotional})`);
                    continue; // exclude from tradeable
                }

                // Clean up float errors, ensuring precision is at least 0
                const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
                tradeAmount = parseFloat(tradeAmount.toFixed(precision));
            }

            const unified: UnifiedMarketInfo = {
                symbol,
                stepSize,
                minQty,
                minNotional,
                tradeAmount, // Pre-calculated fixed amount!
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

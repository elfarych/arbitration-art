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
        binanceClient: IExchangeClient,
        bybitClient: IExchangeClient,
        commonSymbols: string[],
    ): Promise<string[]> {
        logger.info(TAG, `Initializing market info for ${commonSymbols.length} symbols...`);

        // Fetch current prices from Binance to calculate stable reference volume
        let currentPrices: Record<string, number> = {};
        try {
            logger.info(TAG, `Fetching current prices to calculate static trade amounts...`);
            const tickers = await binanceClient.ccxtInstance.fetchTickers(commonSymbols);
            for (const sym in tickers) {
                if (tickers[sym]?.last) {
                    currentPrices[sym] = tickers[sym].last;
                }
            }
        } catch (e: any) {
            logger.warn(TAG, `Could not fetch tickers for exact amounts, will use 0 for now: ${e.message}`);
        }

        const tradeableSymbols: string[] = [];

        for (const symbol of commonSymbols) {
            const binanceInfo = binanceClient.getMarketInfo(symbol);
            const bybitInfo = bybitClient.getMarketInfo(symbol);

            if (!binanceInfo || !bybitInfo) {
                logger.debug(TAG, `Skipping ${symbol}: missing market info on one exchange`);
                continue;
            }

            // Use the strictest constraints from both exchanges
            const stepSize = Math.max(binanceInfo.stepSize, bybitInfo.stepSize);
            const minQty = Math.max(binanceInfo.minQty, bybitInfo.minQty);
            const minNotional = Math.max(binanceInfo.minNotional, bybitInfo.minNotional);

            let tradeAmount = 0;
            const currentPrice = currentPrices[symbol];
            
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
            } else {
                logger.debug(TAG, `Skipping ${symbol}: could not determine current price`);
                continue;
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

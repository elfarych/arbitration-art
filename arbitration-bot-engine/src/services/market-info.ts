import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { UnifiedMarketInfo } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const TAG = 'MarketInfo';

/**
 * Pre-loads and caches unified market info for all tradeable symbols.
 *
 * Called ONCE at bot start — never during trade execution. For every symbol
 * the service stores the strictest of the two exchanges' lot/min/notional
 * constraints so BotTrader cannot pick an amount valid on one leg and
 * rejected on the other. It also runs a homonym-deviation check that drops
 * symbols whose last prices disagree across exchanges by more than 40 %
 * (a strong signal that the tickers refer to different underlying assets).
 *
 * The service is exchange-agnostic: it relies on `IExchangeClient.fetchTicker`
 * and `getMarketInfo`, never on any ccxt-specific shape.
 */
export class MarketInfoService {
    private readonly cache: Map<string, UnifiedMarketInfo> = new Map();

    async initialize(
        primaryClient: IExchangeClient,
        secondaryClient: IExchangeClient,
        commonSymbols: string[],
    ): Promise<string[]> {
        logger.info(TAG, `Initializing market info for ${commonSymbols.length} symbols...`);

        const currentPrices: Record<string, number> = {};
        const secondaryPrices: Record<string, number> = {};
        try {
            logger.info(TAG, `Fetching current prices for amount calculation and collision protection...`);
            // For single-symbol bots, the native fetchTicker is one cheap REST
            // call per exchange — avoid the legacy "fetch all tickers" path
            // entirely; market data WS already provides every other price.
            const results = await Promise.all(commonSymbols.map(async symbol => {
                const [pTicker, sTicker] = await Promise.all([
                    primaryClient.fetchTicker(symbol).catch(err => {
                        logger.warn(TAG, `fetchTicker ${primaryClient.name} ${symbol}: ${err.message}`);
                        return null;
                    }),
                    secondaryClient.fetchTicker(symbol).catch(err => {
                        logger.warn(TAG, `fetchTicker ${secondaryClient.name} ${symbol}: ${err.message}`);
                        return null;
                    }),
                ]);
                return { symbol, pLast: pTicker?.last ?? 0, sLast: sTicker?.last ?? 0 };
            }));
            for (const { symbol, pLast, sLast } of results) {
                if (pLast > 0) currentPrices[symbol] = pLast;
                if (sLast > 0) secondaryPrices[symbol] = sLast;
            }
        } catch (e: any) {
            logger.warn(TAG, `Could not fetch tickers for amounts/collisions: ${e.message}`);
        }

        const tradeableSymbols: string[] = [];

        for (const symbol of commonSymbols) {
            const primaryInfo = primaryClient.getMarketInfo(symbol);
            const secondaryInfo = secondaryClient.getMarketInfo(symbol);

            if (!primaryInfo || !secondaryInfo) {
                logger.debug(TAG, `Skipping ${symbol}: missing market info on one exchange`);
                continue;
            }

            const stepSize = Math.max(primaryInfo.stepSize, secondaryInfo.stepSize);
            const minQty = Math.max(primaryInfo.minQty, secondaryInfo.minQty);
            const minNotional = Math.max(primaryInfo.minNotional, secondaryInfo.minNotional);

            let tradeAmount = 0;
            const currentPrice = currentPrices[symbol];
            const secondaryPrice = secondaryPrices[symbol];

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
                tradeAmount = Math.floor(rawAmount / stepSize) * stepSize;
                const notionalValue = tradeAmount * currentPrice;
                if (tradeAmount < minQty || notionalValue < minNotional) {
                    logger.debug(TAG, `Skipping ${symbol}: calculated amount ${tradeAmount} does not meet minimums.`);
                    continue;
                }
                const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
                tradeAmount = parseFloat(tradeAmount.toFixed(precision));
            }

            this.cache.set(symbol, {
                symbol,
                stepSize,
                minQty,
                minNotional,
                tradeAmount,
                tradeable: true,
            });
            tradeableSymbols.push(symbol);
        }

        logger.info(TAG, `Tradeable symbols: ${tradeableSymbols.length}/${commonSymbols.length}`);
        return tradeableSymbols;
    }

    getInfo(symbol: string): UnifiedMarketInfo | undefined {
        return this.cache.get(symbol);
    }
}

import type { OrderbookPrices } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Calculates the "Open Spread" depending on direction (sell/buy).
 * Sell: Sell on Binance (primary), buy on Bybit (secondary) -> (pBid - sAsk) / sAsk * 100
 * Buy:  Buy on Binance (primary), sell on Bybit (secondary) -> (sBid - pAsk) / pAsk * 100
 */
export function calculateOpenSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'sell') {
        const pBid = prices.primaryBid;
        const sAsk = prices.secondaryAsk;
        if (!sAsk) return -Infinity;
        return ((pBid - sAsk) / sAsk) * 100;
    } else {
        const pAsk = prices.primaryAsk;
        const sBid = prices.secondaryBid;
        if (!pAsk) return -Infinity;
        return ((sBid - pAsk) / pAsk) * 100;
    }
}

/**
 * Classic "True" PnL in percent.
 * Calculates absolute profit in base (USDT) by summing the open profit
 * and close reversal cost, then dividing by the initial capital.
 */
export function calculateTruePnL(
    openPrices: { pOpen: number; sOpen: number },
    currentPrices: OrderbookPrices,
    orderType: 'buy' | 'sell'
): number {
    if (orderType === 'sell') {
        // Short on Binance (pOpen = pBid), long on Bybit (sOpen = sAsk).
        // Close: buy on Binance (pAsk), sell on Bybit (sBid).
        const profitUsdt =
            (openPrices.pOpen - openPrices.sOpen) +
            (currentPrices.secondaryBid - currentPrices.primaryAsk);

        const entryPrice = openPrices.sOpen;
        const estimatedFeesUsdt = entryPrice * 0.0020;
        return ((profitUsdt - estimatedFeesUsdt) / entryPrice) * 100;
    } else {
        // Long on Binance (pOpen = pAsk), short on Bybit (sOpen = sBid).
        // Close: sell on Binance (pBid), buy on Bybit (sAsk).
        const profitUsdt =
            (openPrices.sOpen - openPrices.pOpen) +
            (currentPrices.primaryBid - currentPrices.secondaryAsk);

        const entryPrice = openPrices.pOpen;
        const estimatedFeesUsdt = entryPrice * 0.0020;
        return ((profitUsdt - estimatedFeesUsdt) / entryPrice) * 100;
    }
}

/**
 * Calculates actual PnL in USDT from fill prices and commissions.
 * This is the definitive profit metric for real trades.
 */
export function calculateRealPnL(
    openPrimary: number,
    openSecondary: number,
    closePrimary: number,
    closeSecondary: number,
    amount: number,
    orderType: 'buy' | 'sell',
    totalCommission: number,
): { profitUsdt: number; profitPercentage: number } {
    let profitUsdt: number;

    if (orderType === 'sell') {
        // Short Binance (opened at pBid, closed at pAsk) + Long Bybit (opened at sAsk, closed at sBid)
        const binancePnl = (openPrimary - closePrimary) * amount;
        const bybitPnl = (closeSecondary - openSecondary) * amount;
        profitUsdt = binancePnl + bybitPnl - totalCommission;
    } else {
        // Long Binance (opened at pAsk, closed at pBid) + Short Bybit (opened at sBid, closed at sAsk)
        const binancePnl = (closePrimary - openPrimary) * amount;
        const bybitPnl = (openSecondary - closeSecondary) * amount;
        profitUsdt = binancePnl + bybitPnl - totalCommission;
    }

    const capital = amount * Math.min(openPrimary, openSecondary);
    const profitPercentage = capital > 0 ? (profitUsdt / capital) * 100 : 0;

    return { profitUsdt, profitPercentage };
}

/** Round a number to fit Django DecimalField constraints */
export function d(value: number, decimals: number = 8): number {
    return parseFloat(value.toFixed(decimals));
}

/**
 * Calculates the maximum drawdown matching the isolated margin among the two legs.
 * Returns the highest negative percent (e.g. 85 for -85% PnL on margin).
 */
export function checkLegDrawdown(
    openPrices: { pOpen: number; sOpen: number },
    currentPrices: OrderbookPrices,
    orderType: 'buy' | 'sell',
    leverage: number,
): number {
    let pnlPrimaryRaw: number;
    let pnlSecondaryRaw: number;

    if (orderType === 'sell') {
        // Short Binance, Long Bybit
        // Short PnL percent: (Entry - Current) / Entry
        pnlPrimaryRaw = (openPrices.pOpen - currentPrices.primaryAsk) / openPrices.pOpen;
        // Long PnL percent: (Current - Entry) / Entry
        pnlSecondaryRaw = (currentPrices.secondaryBid - openPrices.sOpen) / openPrices.sOpen;
    } else {
        // Long Binance, Short Bybit
        pnlPrimaryRaw = (currentPrices.primaryBid - openPrices.pOpen) / openPrices.pOpen;
        pnlSecondaryRaw = (openPrices.sOpen - currentPrices.secondaryAsk) / openPrices.sOpen;
    }

    // Convert to percentage and scale by leverage
    const pnlPrimaryPercent = pnlPrimaryRaw * 100 * leverage;
    const pnlSecondaryPercent = pnlSecondaryRaw * 100 * leverage;

    // We only care about negative PnL (drawdown)
    const drawdownPrimary = pnlPrimaryPercent < 0 ? Math.abs(pnlPrimaryPercent) : 0;
    const drawdownSecondary = pnlSecondaryPercent < 0 ? Math.abs(pnlSecondaryPercent) : 0;

    return Math.max(drawdownPrimary, drawdownSecondary);
}

/**
 * Calculates Volume-Weighted Average Price (VWAP) across the orderbook side.
 * Returns `NaN` if there is not enough liquidity to fill `targetCoins`.
 * @param orderbookSide Array of [price, volume] orderbook levels.
 * @param targetCoins Total required base currency quantity.
 */
export function calculateVWAP(orderbookSide: [number, number][], targetCoins: number, isEmergency: boolean = false): number {
    if (!orderbookSide || orderbookSide.length === 0) return NaN;
    if (targetCoins <= 0) return orderbookSide[0][0];

    let accCoins = 0;
    let accQuoteVal = 0;

    for (const [price, volumeCoins] of orderbookSide) {
        if (accCoins + volumeCoins >= targetCoins) {
            const neededCoins = targetCoins - accCoins;
            accCoins += neededCoins;
            accQuoteVal += neededCoins * price;
            break;
        } else {
            accCoins += volumeCoins;
            accQuoteVal += volumeCoins * price;
        }
    }

    if (accCoins < targetCoins) {
        if (!isEmergency) {
            // КРИТИЧЕСКИЙ ФИКС: Для Входа и Тейк-Профита нам НУЖЕН полный объем. 
            // Если в стакане не хватает монет - возвращаем NaN (Отменяем сигнал!)
            return NaN;
        }
        // В случае экстренной ликвидации или таймаута берем что есть
        logger.warn('Math', `Insufficient depth to fill ${targetCoins}. Using VWAP of available ${accCoins}`);
        return accQuoteVal / accCoins;
    }

    return accQuoteVal / targetCoins;
}

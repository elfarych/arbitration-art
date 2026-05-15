import type { OrderbookPrices } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Calculates the "Open Spread" depending on direction (sell/buy).
 * Sell: Sell on Binance (primary), buy on Bybit (secondary) -> (pBid - sAsk) / sAsk * 100
 * Buy:  Buy on Binance (primary), sell on Bybit (secondary) -> (sBid - pAsk) / pAsk * 100
 */
export function calculateOpenSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'sell') {
        // Entry for a sell-type arbitrage: sell/short primary at bid and buy/long
        // secondary at ask. Positive spread means primary is richer than secondary.
        const pBid = prices.primaryBid;
        const sAsk = prices.secondaryAsk;
        if (!sAsk) return -Infinity;
        return ((pBid - sAsk) / sAsk) * 100;
    } else {
        // Entry for a buy-type arbitrage: buy/long primary at ask and sell/short
        // secondary at bid. Positive spread means secondary is richer than primary.
        const pAsk = prices.primaryAsk;
        const sBid = prices.secondaryBid;
        if (!pAsk) return -Infinity;
        return ((sBid - pAsk) / pAsk) * 100;
    }
}

/**
 * Live "Close Spread" computed from the orderbook sides we would actually hit
 * when reversing the position. Mirrors the frontend spreadMonitor formula so
 * UI's "Цель: <= exit_spread" stays semantically aligned with the engine's
 * exit trigger.
 *
 * Buy:  close = sell primary @ pBid, buy secondary @ sAsk -> (sAsk - pBid) / pBid * 100
 * Sell: close = buy primary @ pAsk, sell secondary @ sBid -> (pAsk - sBid) / sBid * 100
 *
 * A positive value means the legs have not converged yet (residual spread);
 * the bot closes once this narrows down to <= bot.exit_spread.
 */
export function calculateCloseSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'buy') {
        const pBid = prices.primaryBid;
        const sAsk = prices.secondaryAsk;
        if (!pBid) return Infinity;
        return ((sAsk - pBid) / pBid) * 100;
    } else {
        const pAsk = prices.primaryAsk;
        const sBid = prices.secondaryBid;
        if (!sBid) return Infinity;
        return ((pAsk - sBid) / sBid) * 100;
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
    // Django DecimalField accepts JSON numbers, but trimming precision here
    // avoids sending values with long binary floating-point tails.
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

    // Convert to percentage and scale by leverage so the result approximates
    // isolated margin drawdown rather than raw asset-price movement.
    const pnlPrimaryPercent = pnlPrimaryRaw * 100 * leverage;
    const pnlSecondaryPercent = pnlSecondaryRaw * 100 * leverage;

    // Only negative PnL contributes to drawdown. Profitable legs do not offset a
    // losing leg for liquidation-risk purposes.
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
        // Consume each level until the target size is filled. If the next level
        // has more volume than needed, use only the remaining required amount.
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
            // Entry and profit-taking require full visible liquidity. Returning
            // NaN cancels the signal instead of letting the bot trade on a partial
            // book and underestimate slippage.
            return NaN;
        }
        // Emergency exits can use available depth because leaving risk open may
        // be worse than accepting a less accurate VWAP estimate.
        logger.warn('Math', `Insufficient depth to fill ${targetCoins}. Using VWAP of available ${accCoins}`);
        return accQuoteVal / accCoins;
    }

    return accQuoteVal / targetCoins;
}

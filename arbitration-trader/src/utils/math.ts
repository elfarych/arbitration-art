import type { OrderbookPrices } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Calculates the "Open Spread" depending on direction (sell/buy).
 * Sell: Sell on Binance (primary), buy on Bybit (secondary) -> (pBid - sAsk) / sAsk * 100
 * Buy:  Buy on Binance (primary), sell on Bybit (secondary) -> (sBid - pAsk) / pAsk * 100
 */
export function calculateOpenSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'sell') {
        // Sell/short primary at bid and buy/long secondary at ask.
        const pBid = prices.primaryBid;
        const sAsk = prices.secondaryAsk;
        if (!sAsk) return -Infinity;
        return ((pBid - sAsk) / sAsk) * 100;
    } else {
        // Buy/long primary at ask and sell/short secondary at bid.
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
        // Signal-level fee estimate only. Final accounting uses real exchange
        // commissions in calculateRealPnL().
        const estimatedFeesUsdt = entryPrice * 0.0020;
        return ((profitUsdt - estimatedFeesUsdt) / entryPrice) * 100;
    } else {
        // Long on Binance (pOpen = pAsk), short on Bybit (sOpen = sBid).
        // Close: sell on Binance (pBid), buy on Bybit (sAsk).
        const profitUsdt =
            (openPrices.sOpen - openPrices.pOpen) +
            (currentPrices.primaryBid - currentPrices.secondaryAsk);

        const entryPrice = openPrices.pOpen;
        // Keep fee assumptions symmetric across both entry directions.
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

export function calculateRealPnLByLegSizes(
    openPrimary: number,
    openSecondary: number,
    closePrimary: number,
    closeSecondary: number,
    primaryAmount: number,
    secondaryAmount: number,
    orderType: 'buy' | 'sell',
    totalCommission: number,
): { profitUsdt: number; profitPercentage: number } {
    let primaryPnl: number;
    let secondaryPnl: number;

    if (orderType === 'sell') {
        primaryPnl = (openPrimary - closePrimary) * primaryAmount;
        secondaryPnl = (closeSecondary - openSecondary) * secondaryAmount;
    } else {
        primaryPnl = (closePrimary - openPrimary) * primaryAmount;
        secondaryPnl = (openSecondary - closeSecondary) * secondaryAmount;
    }

    const profitUsdt = primaryPnl + secondaryPnl - totalCommission;
    const capital = Math.max(primaryAmount * openPrimary, secondaryAmount * openSecondary);
    const profitPercentage = capital > 0 ? (profitUsdt / capital) * 100 : 0;

    return { profitUsdt, profitPercentage };
}

/** Round a number to fit Django DecimalField constraints */
export function d(value: number, decimals: number = 8): number {
    // Trims binary floating-point tails before sending numeric JSON to Django.
    return parseFloat(value.toFixed(decimals));
}

export function decimalPlaces(value: number | string): number {
    const normalized = normalizeDecimalText(value);
    const decimals = normalized.split('.')[1]?.replace(/0+$/, '');
    return decimals?.length ?? 0;
}

export function commonDecimalStep(...steps: number[]): number {
    const validSteps = steps.filter(step => Number.isFinite(step) && step > 0);
    if (validSteps.length === 0) {
        throw new Error('At least one positive step is required.');
    }

    const maxDecimals = Math.max(...validSteps.map(step => decimalPlaces(step)));
    const scale = 10n ** BigInt(maxDecimals);
    const scaledSteps = validSteps.map(step => decimalToScaledInteger(step, maxDecimals));
    const lcmStep = scaledSteps.reduce((current, next) => lcm(current, next));
    return Number(lcmStep) / Number(scale);
}

export function roundDownToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
        return 0;
    }

    const precision = decimalPlaces(step);
    const rounded = Math.floor((value / step) + 1e-12) * step;
    return Number(rounded.toFixed(precision));
}

function normalizeDecimalText(value: number | string): string {
    const raw = String(value).trim().toLowerCase();
    if (!raw.includes('e')) {
        return raw;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return raw;
    }

    return parsed.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

function decimalToScaledInteger(value: number, decimals: number): bigint {
    const normalized = normalizeDecimalText(value);
    const sign = normalized.startsWith('-') ? -1n : 1n;
    const unsigned = normalized.replace(/^-/, '');
    const [integerPart, fractionPart = ''] = unsigned.split('.');
    const digits = `${integerPart}${fractionPart.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
    return sign * BigInt(digits || '0');
}

function gcd(left: bigint, right: bigint): bigint {
    let a = left < 0n ? -left : left;
    let b = right < 0n ? -right : right;

    while (b !== 0n) {
        const next = a % b;
        a = b;
        b = next;
    }

    return a;
}

function lcm(left: bigint, right: bigint): bigint {
    if (left === 0n || right === 0n) {
        return 0n;
    }

    return (left / gcd(left, right)) * right;
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

    // Convert to percentage and scale by leverage to approximate isolated margin
    // drawdown rather than raw asset price movement.
    const pnlPrimaryPercent = pnlPrimaryRaw * 100 * leverage;
    const pnlSecondaryPercent = pnlSecondaryRaw * 100 * leverage;

    // Only losing legs count toward liquidation risk; winning legs do not offset
    // drawdown for this guard.
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
        // Consume levels until the requested base-coin size is filled.
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
            // NaN cancels the signal instead of underestimating slippage.
            return NaN;
        }
        // Emergency liquidation/timeout exits can use available depth because
        // staying exposed may be worse than accepting an approximate VWAP.
        logger.warn('Math', `Insufficient depth to fill ${targetCoins}. Using VWAP of available ${accCoins}`);
        return accQuoteVal / accCoins;
    }

    return accQuoteVal / targetCoins;
}

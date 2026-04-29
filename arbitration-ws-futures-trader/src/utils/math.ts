export interface OrderbookPrices {
    primaryBid: number;
    primaryAsk: number;
    secondaryBid: number;
    secondaryAsk: number;
}

export function calculateOpenSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'sell') {
        if (prices.secondaryAsk <= 0) {
            return -Infinity;
        }
        return ((prices.primaryBid - prices.secondaryAsk) / prices.secondaryAsk) * 100;
    }

    if (prices.primaryAsk <= 0) {
        return -Infinity;
    }
    return ((prices.secondaryBid - prices.primaryAsk) / prices.primaryAsk) * 100;
}

export function calculateTruePnL(
    openPrices: { pOpen: number; sOpen: number },
    currentPrices: OrderbookPrices,
    orderType: 'buy' | 'sell',
): number {
    if (orderType === 'sell') {
        const profitUsdt = (openPrices.pOpen - openPrices.sOpen) + (currentPrices.secondaryBid - currentPrices.primaryAsk);
        const estimatedFeesUsdt = openPrices.sOpen * 0.0020;
        return ((profitUsdt - estimatedFeesUsdt) / openPrices.sOpen) * 100;
    }

    const profitUsdt = (openPrices.sOpen - openPrices.pOpen) + (currentPrices.primaryBid - currentPrices.secondaryAsk);
    const estimatedFeesUsdt = openPrices.pOpen * 0.0020;
    return ((profitUsdt - estimatedFeesUsdt) / openPrices.pOpen) * 100;
}

export function calculateRealPnL(
    openPrimary: number,
    openSecondary: number,
    closePrimary: number,
    closeSecondary: number,
    amount: number,
    orderType: 'buy' | 'sell',
    totalCommission: number,
): { profitUsdt: number; profitPercentage: number } {
    const primaryPnl = orderType === 'sell'
        ? (openPrimary - closePrimary) * amount
        : (closePrimary - openPrimary) * amount;
    const secondaryPnl = orderType === 'sell'
        ? (closeSecondary - openSecondary) * amount
        : (openSecondary - closeSecondary) * amount;
    const profitUsdt = primaryPnl + secondaryPnl - totalCommission;
    const capital = amount * Math.min(openPrimary, openSecondary);
    return {
        profitUsdt,
        profitPercentage: capital > 0 ? (profitUsdt / capital) * 100 : 0,
    };
}

export function decimalPlaces(value: number | string): number {
    const normalized = normalizeDecimalText(value);
    const decimals = normalized.split('.')[1]?.replace(/0+$/, '');
    return decimals?.length ?? 0;
}

export function roundDownToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
        return 0;
    }

    const precision = decimalPlaces(step);
    const rounded = Math.floor((value / step) + 1e-12) * step;
    return Number(rounded.toFixed(precision));
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

export function calculateVWAP(levels: [number, number][], targetQty: number): number {
    if (levels.length === 0 || targetQty <= 0) {
        return Number.NaN;
    }

    let filledQty = 0;
    let quoteValue = 0;

    for (const [price, qty] of levels) {
        const takeQty = Math.min(qty, targetQty - filledQty);
        filledQty += takeQty;
        quoteValue += takeQty * price;
        if (filledQty >= targetQty) {
            break;
        }
    }

    return filledQty >= targetQty ? quoteValue / targetQty : Number.NaN;
}

export function d(value: number, decimals = 8): number {
    return Number(value.toFixed(decimals));
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

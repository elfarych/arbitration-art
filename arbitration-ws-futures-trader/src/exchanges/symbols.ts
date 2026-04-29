export type UnifiedSymbol = `${string}/USDT:USDT`;

export function unifiedToExchangeSymbol(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '');
}

export function exchangeToUnified(symbol: string): UnifiedSymbol {
    const upper = symbol.toUpperCase();
    if (upper.endsWith('USDT')) {
        return `${upper.slice(0, -4)}/USDT:USDT` as UnifiedSymbol;
    }
    return `${upper}/USDT:USDT` as UnifiedSymbol;
}

export function normalizeClientOrderId(prefix: string, id: string): string {
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(-24);
    return `${prefix}${safe}`.slice(0, 36);
}

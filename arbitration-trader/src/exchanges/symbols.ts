export type UnifiedSymbol = `${string}/USDT:USDT`;

export function unifiedToBinance(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '');
}

export function unifiedToBybit(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '');
}

export function unifiedToGate(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '_');
}

export function unifiedToMexc(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '_');
}

export function binanceToUnified(symbol: string): UnifiedSymbol {
    if (!symbol.endsWith('USDT')) {
        return `${symbol}/USDT:USDT` as UnifiedSymbol;
    }

    return `${symbol.slice(0, -4)}/USDT:USDT` as UnifiedSymbol;
}

export function gateToUnified(symbol: string): UnifiedSymbol {
    if (!symbol.endsWith('_USDT')) {
        return `${symbol.replace('_', '/')}:USDT` as UnifiedSymbol;
    }

    return `${symbol.replace('_USDT', '')}/USDT:USDT` as UnifiedSymbol;
}

export function bybitToUnified(symbol: string): UnifiedSymbol {
    if (!symbol.endsWith('USDT')) {
        return `${symbol}/USDT:USDT` as UnifiedSymbol;
    }

    return `${symbol.slice(0, -4)}/USDT:USDT` as UnifiedSymbol;
}

export function mexcToUnified(symbol: string): UnifiedSymbol {
    if (!symbol.endsWith('_USDT')) {
        return `${symbol.replace('_', '/')}:USDT` as UnifiedSymbol;
    }

    return `${symbol.replace('_USDT', '')}/USDT:USDT` as UnifiedSymbol;
}

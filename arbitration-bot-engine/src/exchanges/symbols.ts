/**
 * Symbol conversion helpers.
 *
 * The engine standardises on the ccxt-style unified symbol `BASE/USDT:USDT`
 * because Django bot configs, MarketInfoService cache keys and BotTrader
 * pair state are all keyed by it. Each native exchange client converts to
 * and from the exchange's own symbol format using these helpers.
 */

/** Strip the unified suffix and join base/quote — `BTC/USDT:USDT` → `BTCUSDT`. */
export function unifiedToBinance(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '');
}

/** Inverse of `unifiedToBinance` — `BTCUSDT` → `BTC/USDT:USDT`. */
export function binanceToUnified(exchangeSymbol: string): string {
    const upper = exchangeSymbol.toUpperCase();
    if (upper.endsWith('USDT')) {
        return `${upper.slice(0, -4)}/USDT:USDT`;
    }
    return upper;
}

/** Bybit linear uses the same compact symbol as Binance. */
export const unifiedToBybit = unifiedToBinance;
export const bybitToUnified = binanceToUnified;

/** `BTC/USDT:USDT` → `BTC_USDT` for MEXC contract and Gate futures. */
export function unifiedToUnderscored(symbol: string): string {
    return symbol.replace(':USDT', '').replace('/', '_');
}

/** `BTC_USDT` → `BTC/USDT:USDT`. */
export function underscoredToUnified(exchangeSymbol: string): string {
    return `${exchangeSymbol.replace('_', '/')}:USDT`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedRuntimeConfig, ExchangeName } from '../src/config.js';
import type { SymbolMarketInfo } from '../src/exchanges/exchange-types.js';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('symbol selection prioritizes shared absolute 24h price change', async () => {
    const { selectSymbols } = await import('../src/runtime/runtime-manager.js');
    const runtime = { topLiquidPairsCount: 2 } as NormalizedRuntimeConfig;
    const binance = new Map<string, SymbolMarketInfo>([
        ['BTC/USDT:USDT', market('binance', 'BTC/USDT:USDT', 100_000_000, 1)],
        ['ETH/USDT:USDT', market('binance', 'ETH/USDT:USDT', 1_000_000, 12)],
        ['XRP/USDT:USDT', market('binance', 'XRP/USDT:USDT', 10_000_000, -5)],
        ['SOL/USDT:USDT', market('binance', 'SOL/USDT:USDT', 50_000_000, 30)],
    ]);
    const bybit = new Map<string, SymbolMarketInfo>([
        ['BTC/USDT:USDT', market('bybit', 'BTC/USDT:USDT', 90_000_000, 1.2)],
        ['ETH/USDT:USDT', market('bybit', 'ETH/USDT:USDT', 900_000, -11)],
        ['XRP/USDT:USDT', market('bybit', 'XRP/USDT:USDT', 8_000_000, 6)],
    ]);

    assert.deepEqual(selectSymbols(binance, bybit, runtime), [
        'ETH/USDT:USDT',
        'XRP/USDT:USDT',
    ]);
});

test('symbol selection uses shared quote volume only as a tie breaker', async () => {
    const { selectSymbols } = await import('../src/runtime/runtime-manager.js');
    const runtime = { topLiquidPairsCount: 2 } as NormalizedRuntimeConfig;
    const binance = new Map<string, SymbolMarketInfo>([
        ['ADA/USDT:USDT', market('binance', 'ADA/USDT:USDT', 10_000, 5)],
        ['DOGE/USDT:USDT', market('binance', 'DOGE/USDT:USDT', 100_000, 5)],
    ]);
    const bybit = new Map<string, SymbolMarketInfo>([
        ['ADA/USDT:USDT', market('bybit', 'ADA/USDT:USDT', 9_000, 5)],
        ['DOGE/USDT:USDT', market('bybit', 'DOGE/USDT:USDT', 90_000, 5)],
    ]);

    assert.deepEqual(selectSymbols(binance, bybit, runtime), [
        'DOGE/USDT:USDT',
        'ADA/USDT:USDT',
    ]);
});

function market(
    exchange: ExchangeName,
    symbol: string,
    quoteVolume: number,
    priceChangePercent24h: number,
): SymbolMarketInfo {
    return {
        symbol,
        exchange,
        exchangeSymbol: symbol.replace(':USDT', '').replace('/', ''),
        minQty: 0.001,
        stepSize: 0.001,
        minNotional: 5,
        quoteVolume,
        priceChangePercent24h,
    };
}

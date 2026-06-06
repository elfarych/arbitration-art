/** Обнаружение и фильтрация торговых символов Binance Futures. */

import type { BinanceRestClient } from './rest-client';

export interface SymbolVolume {
  symbol: string;
  quoteVolume: number;
}

export class SymbolDiscovery {
  constructor(private readonly rest: BinanceRestClient) {}

  /**
   * Вернуть USDⓈ-M перпетуалы с котировкой USDT и суточным объёмом не ниже
   * порога, отсортированные по объёму (убыв.).
   */
  async discover(minQuoteVolumeUsdt: number): Promise<SymbolVolume[]> {
    const [info, tickers] = await Promise.all([
      this.rest.exchangeInfo(),
      this.rest.ticker24h(),
    ]);

    const tradableUsdtPerp = new Set(
      info.symbols
        .filter(
          (symbol) =>
            symbol.quoteAsset === 'USDT' &&
            symbol.status === 'TRADING' &&
            symbol.contractType === 'PERPETUAL',
        )
        .map((symbol) => symbol.symbol),
    );

    return tickers
      .filter((ticker) => tradableUsdtPerp.has(ticker.symbol))
      .map((ticker) => ({ symbol: ticker.symbol, quoteVolume: Number(ticker.quoteVolume) }))
      .filter((entry) => entry.quoteVolume >= minQuoteVolumeUsdt)
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  }
}

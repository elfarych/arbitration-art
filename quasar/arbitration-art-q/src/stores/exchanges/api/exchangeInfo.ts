import { binanceApi, type ExchangeTickerInfo } from './binanceApi';
import { binanceSpotApi } from './binanceSpotApi';
import { mexcApi } from './mexcApi';
import { bybitApi } from './bybitApi';

export interface BotExchangeInfo {
  primary: ExchangeTickerInfo | null;
  secondary: ExchangeTickerInfo | null;
  loading: boolean;
}

export const exchangeInfoService = {
  async getExchangeInfo(coin: string, exchange: string): Promise<ExchangeTickerInfo | null> {
    switch (exchange) {
      case 'binance_futures':
        return await binanceApi.getTickerInfo(coin);
      case 'binance_spot':
        return await binanceSpotApi.getTickerInfo(coin);
      case 'mexc_futures':
        return await mexcApi.getTickerInfo(coin);
      case 'bybit_futures':
        return await bybitApi.getTickerInfo(coin);
      default:
        return null;
    }
  },

  async getInfo(coin: string, primaryExchange: string, secondaryExchange: string): Promise<BotExchangeInfo> {
    const [primary, secondary] = await Promise.all([
      this.getExchangeInfo(coin, primaryExchange),
      this.getExchangeInfo(coin, secondaryExchange)
    ]);

    return {
      primary,
      secondary,
      loading: false,
    };
  }
};

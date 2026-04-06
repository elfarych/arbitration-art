import { defineStore } from 'pinia';
import { binanceApi } from './api/binanceApi';
import { binanceSpotApi } from './api/binanceSpotApi';
import { mexcApi } from './api/mexcApi';
import { bybitApi } from './api/bybitApi';
import { exchangeInfoService, type BotExchangeInfo } from './api/exchangeInfo';
import type { BotConfig } from 'src/stores/bots/api/botConfig';

export const useExchangesStore = defineStore('exchanges', {
  state: () => ({}),
  actions: {
    async fetchExchangeInfo(coin: string, primary: string, secondary: string): Promise<BotExchangeInfo> {
      return exchangeInfoService.getInfo(coin, primary, secondary);
    },

    async validateSymbol(coin: string, primary: string, secondary: string) {
      let pExists = false, sExists = false;
      let priceCache = 0;
      
      if (primary === 'binance_futures') pExists = await binanceApi.symbolExists(coin);
      else if (primary === 'binance_spot') pExists = await binanceSpotApi.symbolExists(coin);
      else if (primary === 'bybit_futures') pExists = await bybitApi.symbolExists(coin);
      else pExists = await mexcApi.symbolExists(coin);

      if (secondary === 'mexc_futures') sExists = await mexcApi.symbolExists(coin);
      else if (secondary === 'binance_spot') sExists = await binanceSpotApi.symbolExists(coin);
      else if (secondary === 'bybit_futures') sExists = await bybitApi.symbolExists(coin);
      else sExists = await binanceApi.symbolExists(coin);

      if (pExists) {
        let price = null;
        if (primary === 'binance_futures') price = await binanceApi.getPrice(coin);
        else if (primary === 'binance_spot') price = await binanceSpotApi.getPrice(coin);
        else if (primary === 'bybit_futures') price = await bybitApi.getPrice(coin);
        else price = await mexcApi.getPrice(coin);
        
        if (price) priceCache = price;
      }

      return {
        primaryExists: pExists,
        secondaryExists: sExists,
        price: priceCache
      };
    },

    async getSpreadHistory(bot: BotConfig) {
      const limitParams = 60 * 6; // last 6 hours based on 1m klines
      
      let pkPromise, skPromise;
      if (bot.primary_exchange === 'binance_futures') pkPromise = binanceApi.getKlines(bot.coin, limitParams);
      else if (bot.primary_exchange === 'binance_spot') pkPromise = binanceSpotApi.getKlines(bot.coin, limitParams);
      else if (bot.primary_exchange === 'bybit_futures') pkPromise = bybitApi.getKlines(bot.coin, limitParams);
      else pkPromise = mexcApi.getKlines(bot.coin, limitParams);

      if (bot.secondary_exchange === 'mexc_futures') skPromise = mexcApi.getKlines(bot.coin, limitParams);
      else if (bot.secondary_exchange === 'binance_spot') skPromise = binanceSpotApi.getKlines(bot.coin, limitParams);
      else if (bot.secondary_exchange === 'bybit_futures') skPromise = bybitApi.getKlines(bot.coin, limitParams);
      else skPromise = binanceApi.getKlines(bot.coin, limitParams);

      const [primaryKlines, secondaryKlines] = await Promise.all([pkPromise, skPromise]);

      const openData: { time: number, value: number }[] = [];
      const closeData: { time: number, value: number }[] = [];
      const pMap = new Map();
      
      primaryKlines.forEach(k => pMap.set(k.timestamp, k.close));
      
      for (const sk of secondaryKlines) {
        const pkClose = pMap.get(sk.timestamp);
        if (pkClose !== undefined) {
          const openS = ((pkClose - sk.close) / sk.close) * 100;
          const closeS = ((sk.close - pkClose) / pkClose) * 100;
          const time = Math.floor(sk.timestamp / 1000);
          openData.push({ time, value: openS });
          closeData.push({ time, value: closeS });
        }
      }

      openData.sort((a,b) => a.time - b.time);
      closeData.sort((a,b) => a.time - b.time);

      return { openData, closeData };
    }
  }
});

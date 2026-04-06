import { defineStore } from 'pinia';
import { ref } from 'vue';
import { binanceApi } from 'src/stores/exchanges/api/binanceApi';
import { binanceSpotApi } from 'src/stores/exchanges/api/binanceSpotApi';
import { mexcApi } from 'src/stores/exchanges/api/mexcApi';
import { bybitApi } from 'src/stores/exchanges/api/bybitApi';

export interface ScreenerResult {
  coin: string;
  primaryPrice: number;
  secondaryPrice: number;
  spread: number;
}

const apiMap: Record<string, any> = {
  binance_futures: binanceApi,
  binance_spot: binanceSpotApi,
  mexc_futures: mexcApi,
  bybit_futures: bybitApi,
};

export const useScreenerStore = defineStore('screener', () => {
  const primaryExchange = ref('binance_futures');
  const secondaryExchange = ref('mexc_futures');
  const orderType = ref<'buy' | 'sell'>('buy');
  const results = ref<ScreenerResult[]>([]);
  const loading = ref(false);
  const minVolume = ref<number | null>(null);

  const scanSpreads = async () => {
    loading.value = true;
    results.value = [];
    
    try {
      const pApi = apiMap[primaryExchange.value];
      const sApi = apiMap[secondaryExchange.value];

      if (!pApi || !sApi) {
        throw new Error('Unsupported exchange');
      }

      const [pData, sData] = await Promise.all([
        pApi.getAllTickers(),
        sApi.getAllTickers()
      ]);

      const matched: ScreenerResult[] = [];

      for (const coin in pData) {
        if (sData[coin]) {
          const p = pData[coin];
          const s = sData[coin];

          if (!p.bid || !p.ask || !s.bid || !s.ask) continue;

          let openSpread: number;
          let pPrice: number;
          let sPrice: number;

          if (orderType.value === 'buy') {
            // Buy Primary, Sell Secondary
            openSpread = ((s.bid - p.ask) / p.ask) * 100;
            pPrice = p.ask;
            sPrice = s.bid;
          } else {
            // Sell Primary, Buy Secondary
            openSpread = ((p.bid - s.ask) / s.ask) * 100;
            pPrice = p.bid;
            sPrice = s.ask;
          }

          matched.push({
            coin,
            primaryPrice: pPrice,
            secondaryPrice: sPrice,
            spread: openSpread
          });
        }
      }

      // Sort by highest spread
      matched.sort((a, b) => b.spread - a.spread);

      results.value = matched;

    } catch (e) {
      console.error('Scan failed:', e);
    } finally {
      loading.value = false;
    }
  };

  return {
    primaryExchange,
    secondaryExchange,
    orderType,
    results,
    loading,
    minVolume,
    scanSpreads
  };
});

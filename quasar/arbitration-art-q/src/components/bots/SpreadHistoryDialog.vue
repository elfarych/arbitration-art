<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" maximized transition-show="slide-up" transition-hide="slide-down">
    <q-card class="bg-dark text-text-color column">
      <q-card-section class="row items-center justify-between head-bar border-bottom-dark q-pa-md">
        <div class="text-h6 text-title-color text-weight-bold">
          История спреда: <span class="text-primary">{{ bot?.coin }}</span>
        </div>
        <q-btn icon="close" flat round dense v-close-popup color="grey-5" />
      </q-card-section>
      
      <q-card-section class="col full-height q-pa-none relative-position">
        <div v-if="loading" class="flex flex-center full-height opacity-70">
          <q-spinner size="lg" color="primary" class="q-mr-sm"/> Загрузка исторических данных...
        </div>
        <div v-if="error" class="flex flex-center full-height text-negative">{{ error }}</div>
        
        <div ref="chartContainer" class="chart-container" :class="{ 'hidden': loading || error }"></div>
        
        <div v-if="!loading && !error" class="legend-panel">
          <div class="legend-item"><span class="legend-color bg-positive"></span> Open Spread</div>
          <div class="legend-item"><span class="legend-color bg-negative"></span> Close Spread</div>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue';
import { createChart, type IChartApi, type ISeriesApi, ColorType } from 'lightweight-charts';
import type { BotConfig } from 'src/services/api/botConfig';
import { binanceApi } from 'src/services/exchanges/binanceApi';
import { mexcApi } from 'src/services/exchanges/mexcApi';

const props = defineProps<{
  modelValue: boolean;
  bot: BotConfig | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const chartContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref('');

let chart: IChartApi | null = null;
let openSeries: ISeriesApi<'Line'> | null = null;
let closeSeries: ISeriesApi<'Line'> | null = null;

const initChart = () => {
  if (!chartContainer.value) return;
  if (chart) {
    chart.remove();
  }

  chart = createChart(chartContainer.value, {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: 'rgba(255, 255, 255, 0.7)',
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.1)',
      timeVisible: true,
      secondsVisible: false,
    },
    autoSize: true,
  });

  openSeries = chart.addLineSeries({
    color: '#4caf50',
    lineWidth: 2,
    priceLineVisible: false,
  });

  closeSeries = chart.addLineSeries({
    color: '#f44336',
    lineWidth: 2,
    priceLineVisible: false,
  });
};

const loadHistory = async () => {
  if (!props.bot) return;
  loading.value = true;
  error.value = '';

  try {
    const limitParams = 60 * 6; // last 6 hours based on 1m klines
    
    let pkPromise, skPromise;
    
    if (props.bot.primary_exchange === 'binance_futures') pkPromise = binanceApi.getKlines(props.bot.coin, limitParams);
    else pkPromise = mexcApi.getKlines(props.bot.coin, limitParams);

    if (props.bot.secondary_exchange === 'mexc_futures') skPromise = mexcApi.getKlines(props.bot.coin, limitParams);
    else skPromise = binanceApi.getKlines(props.bot.coin, limitParams);

    const [primaryKlines, secondaryKlines] = await Promise.all([pkPromise, skPromise]);

    const openData = [];
    const closeData = [];
    const pMap = new Map();
    primaryKlines.forEach(k => pMap.set(k.timestamp, k.close));
    
    for (const sk of secondaryKlines) {
      const pkClose = pMap.get(sk.timestamp);
      if (pkClose !== undefined) {
        const openS = ((pkClose - sk.close) / sk.close) * 100;
        const closeS = ((sk.close - pkClose) / pkClose) * 100;
        
        // TradingView requires Unix timestamp in seconds
        const time = Math.floor(sk.timestamp / 1000) as any;
        
        openData.push({ time, value: openS });
        closeData.push({ time, value: closeS });
      }
    }

    openData.sort((a,b) => a.time - b.time);
    closeData.sort((a,b) => a.time - b.time);

    await nextTick();
    if (!chart) initChart();
    
    openSeries?.setData(openData);
    closeSeries?.setData(closeData);
    chart?.timeScale().fitContent();
    
  } catch (err) {
    console.error(err);
    error.value = 'Не удалось загрузить историю!';
  } finally {
    loading.value = false;
  }
};

watch(() => props.modelValue, (val) => {
  if (val) {
    nextTick(() => {
      initChart();
      loadHistory();
    });
  } else {
    if (chart) {
      chart.remove();
      chart = null;
    }
  }
});

onUnmounted(() => {
  if (chart) chart.remove();
});
</script>

<style lang="sass" scoped>
.head-bar
  height: 64px
  
.border-bottom-dark
  border-bottom: 1px solid $blue-dark

.chart-container
  width: 100%
  height: 100%
  
.hidden
  display: none

.legend-panel
  position: absolute
  top: 10px
  left: 20px
  display: flex
  flex-direction: column
  gap: 4px
  z-index: 10
  font-size: 13px
  opacity: 0.8
  font-weight: 500

.legend-item
  display: flex
  align-items: center
  gap: 8px

.legend-color
  width: 12px
  height: 3px
  display: inline-block
  border-radius: 2px
</style>

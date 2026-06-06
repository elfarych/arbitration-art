<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="bg-dark text-white breakout-dialog" flat bordered>
      <q-card-section class="row items-center no-wrap q-py-sm">
        <div class="column">
          <span class="text-subtitle1 text-weight-bold">
            {{ symbol }} ·
            <span :class="isUp ? 'text-positive' : 'text-negative'">{{ dirLabel }}</span>
          </span>
          <span class="text-caption text-grey-5">{{ subtitle }}</span>
        </div>
        <q-space />
        <q-btn flat dense round icon="close" color="grey-5" v-close-popup />
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-section class="charts">
        <MiniBreakoutChart
          class="chart-block"
          :title="`Пробой · ${timeframe}`"
          :candles="tfCandles"
          :level-price="level"
          :markers="tfMarkers"
          :loading="tfLoading"
          :error="tfError"
        />
        <MiniBreakoutChart
          class="chart-block"
          title="Посекундно (по трейдам)"
          :candles="secCandles"
          :level-price="level"
          :markers="secMarkers"
          :seconds-visible="true"
          :loading="secLoading"
          :error="secError"
          :empty-text="secEmptyText"
        />
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { CandlestickData, SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { AnalysisBreakout } from 'src/stores/levels/api/levelsApi';
import { fetchKlines } from 'src/stores/levels/api/binanceKlines';
import { fetchAggTradeCandles } from 'src/stores/levels/api/binanceAggTrades';
import MiniBreakoutChart from './MiniBreakoutChart.vue';

const props = defineProps<{
  modelValue: boolean;
  symbol: string;
  timeframe: string;
  maxBreakoutSeconds: number;
  breakout: AnalysisBreakout | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

// Chart A — analysis timeframe: candles around the breakout.
const TF_LIMIT = 160;
const TF_AFTER = 40; // candles shown after the breakout for context
// Chart B — per-second window padding around the breakout.
const SEC_PAD_MS = 20_000;

const tfCandles = ref<CandlestickData[]>([]);
const tfLoading = ref(false);
const tfError = ref('');
const secCandles = ref<CandlestickData[]>([]);
const secLoading = ref(false);
const secError = ref('');

const level = computed(() => props.breakout?.price ?? 0);
const isUp = computed(() => props.breakout?.direction === 'up');
const dirLabel = computed(() => (isUp.value ? '▲ пробой вверх' : '▼ пробой вниз'));

const subtitle = computed(() => {
  const b = props.breakout;
  if (!b) return '';
  const when = new Date(b.breakoutCandleTime).toLocaleString('ru-RU');
  const move = b.movePct === null ? '—' : `${b.movePct.toFixed(2)}%`;
  const time = b.elapsedMs === null ? '—' : `${(b.elapsedMs / 1000).toFixed(1)} с`;
  return `${when} · уровень ${b.price} · движение ${move} · за ${time}${b.matched ? ' · соответствует' : ''}`;
});

function tfMs(tf: string): number {
  const match = /^(\d+)([mhdw])$/.exec(tf);
  if (!match) return 60_000;
  const n = Number(match[1]);
  const unit = match[2];
  const unitMs = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : unit === 'w' ? 604_800_000 : 60_000;
  return n * unitMs;
}

const tfMarkers = computed<SeriesMarker<UTCTimestamp>[]>(() => {
  const b = props.breakout;
  if (!b) return [];
  return [
    {
      time: Math.floor(b.breakoutCandleTime / 1000) as UTCTimestamp,
      position: isUp.value ? 'belowBar' : 'aboveBar',
      color: isUp.value ? '#83c764' : '#ff5d6b',
      shape: isUp.value ? 'arrowUp' : 'arrowDown',
      text: 'пробой',
    },
  ];
});

const secMarkers = computed<SeriesMarker<UTCTimestamp>[]>(() => {
  const b = props.breakout;
  if (!b || b.crossTime === null) return [];
  // Place markers in the margin OPPOSITE the move so they don't cover the price.
  const side = isUp.value ? 'belowBar' : 'aboveBar';
  const shape = isUp.value ? 'arrowUp' : 'arrowDown';
  const crossSec = Math.floor(b.crossTime / 1000) as UTCTimestamp;
  const reachSec = b.reachTime !== null ? (Math.floor(b.reachTime / 1000) as UTCTimestamp) : null;
  // Same second (instant breakout, elapsed 0) → one combined marker, not two
  // stacked on the same bar.
  if (reachSec !== null && reachSec === crossSec) {
    return [{ time: crossSec, position: side, color: '#83c764', shape, text: 'пробой → цель', size: 1 }];
  }
  const markers: SeriesMarker<UTCTimestamp>[] = [
    { time: crossSec, position: side, color: '#f5c542', shape: 'circle', text: 'пробой', size: 1 },
  ];
  if (reachSec !== null) {
    markers.push({ time: reachSec, position: side, color: '#83c764', shape, text: 'цель', size: 1 });
  }
  return markers;
});

// No cross → no meaningful per-second breakout; show why instead of a sparse chart.
const secEmptyText = computed(() =>
  props.breakout && props.breakout.crossTime === null
    ? 'Пробой не подтверждён трейдами — нет трейда за уровнем'
    : 'Нет трейдов в окне пробоя',
);

async function loadTf(): Promise<void> {
  const b = props.breakout;
  if (!b) return;
  tfLoading.value = true;
  tfError.value = '';
  try {
    const endTime = b.breakoutCandleTime + TF_AFTER * tfMs(props.timeframe);
    tfCandles.value = await fetchKlines(props.symbol, props.timeframe, TF_LIMIT, endTime);
  } catch {
    tfError.value = 'Не удалось загрузить свечи';
    tfCandles.value = [];
  } finally {
    tfLoading.value = false;
  }
}

async function loadSeconds(): Promise<void> {
  const b = props.breakout;
  if (!b) return;
  // Without a cross there is no breakout instant to zoom into — skip the fetch
  // and let the chart show secEmptyText instead of a confusing sparse plot.
  if (b.crossTime === null) {
    secCandles.value = [];
    secError.value = '';
    secLoading.value = false;
    return;
  }
  secLoading.value = true;
  secError.value = '';
  try {
    const start = b.crossTime - SEC_PAD_MS;
    const end = b.crossTime + props.maxBreakoutSeconds * 1000 + SEC_PAD_MS;
    secCandles.value = await fetchAggTradeCandles(props.symbol, start, end, 1000);
  } catch {
    secError.value = 'Не удалось загрузить трейды';
    secCandles.value = [];
  } finally {
    secLoading.value = false;
  }
}

// Load both charts when the dialog opens (or the selected breakout changes).
watch(
  () => [props.modelValue, props.breakout] as const,
  ([open, breakout]) => {
    if (open && breakout) {
      void loadTf();
      void loadSeconds();
    }
  },
  { immediate: true },
);
</script>

<style lang="sass" scoped>
.breakout-dialog
  width: 820px
  max-width: 94vw
  border-color: $blue-dark

.charts
  display: flex
  flex-direction: column
  gap: 12px

.chart-block
  height: 280px
</style>

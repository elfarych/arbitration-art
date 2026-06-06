<template>
  <q-dialog
    :model-value="modelValue"
    maximized
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="bg-dark text-white breakout-dialog column no-wrap" flat bordered>
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

      <q-card-section class="charts col">
        <MiniBreakoutChart
          class="chart-top"
          :title="`Пробой · ${timeframe}`"
          :candles="tfCandles"
          :level-price="level"
          :markers="tfMarkers"
          :loading="tfLoading"
          :error="tfError"
        />
        <div class="charts-bottom">
          <MiniBreakoutChart
            class="chart-block"
            title="Посекундно (по трейдам)"
            :candles="secCandles"
            :level-price="level"
            :markers="secMarkers"
            :seconds-visible="true"
            :loading="tradesLoading"
            :error="tradesError"
            :empty-text="secEmptyText"
          />
          <MiniTickChart
            class="chart-block"
            title="Тиковый (по трейдам)"
            :points="tickPoints"
            :level-price="level"
            :markers="tickMarkers"
            :loading="tradesLoading"
            :error="tradesError"
            :empty-text="secEmptyText"
          />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { CandlestickData, LineData, SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { AnalysisBreakout } from 'src/stores/levels/api/levelsApi';
import { fetchKlines } from 'src/stores/levels/api/binanceKlines';
import { fetchAggTradeSeries } from 'src/stores/levels/api/binanceAggTrades';
import MiniBreakoutChart from './MiniBreakoutChart.vue';
import MiniTickChart from './MiniTickChart.vue';

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
// Per-second candles and the raw tick line share one trades fetch (loadTrades),
// so they share loading/error state.
const secCandles = ref<CandlestickData[]>([]);
const tickPoints = ref<LineData[]>([]);
const tradesLoading = ref(false);
const tradesError = ref('');

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

// Time of the tick nearest to a target (ms). Tick times are seconds with a ms
// fraction and never line up with crossTime/reachTime exactly, so markers snap
// to the closest existing point (line-series markers must sit on a data point).
// Points are ascending — stop once the gap starts growing past the target.
function nearestTickTime(points: LineData[], targetMs: number): UTCTimestamp | null {
  const targetSec = targetMs / 1000;
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const p of points) {
    const t = p.time as number;
    const diff = Math.abs(t - targetSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    } else if (t > targetSec) {
      break;
    }
  }
  return best as UTCTimestamp | null;
}

// Same breakout/target markers as the per-second chart, but placed on the
// nearest tick so the cross/reach points are visible on the tick line too.
const tickMarkers = computed<SeriesMarker<UTCTimestamp>[]>(() => {
  const b = props.breakout;
  const points = tickPoints.value;
  if (!b || b.crossTime === null || points.length === 0) return [];
  const side = isUp.value ? 'belowBar' : 'aboveBar';
  const shape = isUp.value ? 'arrowUp' : 'arrowDown';
  const crossT = nearestTickTime(points, b.crossTime);
  const reachT = b.reachTime !== null ? nearestTickTime(points, b.reachTime) : null;
  if (crossT === null) return [];
  // Cross and reach snapped to the same tick → one combined marker.
  if (reachT !== null && reachT === crossT) {
    return [{ time: crossT, position: side, color: '#83c764', shape, text: 'пробой → цель', size: 1 }];
  }
  const markers: SeriesMarker<UTCTimestamp>[] = [
    { time: crossT, position: side, color: '#f5c542', shape: 'circle', text: 'пробой', size: 1 },
  ];
  if (reachT !== null) {
    markers.push({ time: reachT, position: side, color: '#83c764', shape, text: 'цель', size: 1 });
  }
  return markers;
});

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

async function loadTrades(): Promise<void> {
  const b = props.breakout;
  if (!b) return;
  // Without a cross there is no breakout instant to zoom into — skip the fetch
  // and let the charts show secEmptyText instead of a confusing sparse plot.
  if (b.crossTime === null) {
    secCandles.value = [];
    tickPoints.value = [];
    tradesError.value = '';
    tradesLoading.value = false;
    return;
  }
  tradesLoading.value = true;
  tradesError.value = '';
  try {
    const start = b.crossTime - SEC_PAD_MS;
    const end = b.crossTime + props.maxBreakoutSeconds * 1000 + SEC_PAD_MS;
    // One trades fetch feeds both the per-second candles and the tick line.
    const { candles, ticks } = await fetchAggTradeSeries(props.symbol, start, end);
    secCandles.value = candles;
    tickPoints.value = ticks;
  } catch {
    tradesError.value = 'Не удалось загрузить трейды';
    secCandles.value = [];
    tickPoints.value = [];
  } finally {
    tradesLoading.value = false;
  }
}

// Load all charts when the dialog opens (or the selected breakout changes).
watch(
  () => [props.modelValue, props.breakout] as const,
  ([open, breakout]) => {
    if (open && breakout) {
      void loadTf();
      void loadTrades();
    }
  },
  { immediate: true },
);
</script>

<style lang="sass" scoped>
// Full-screen dialog: the card fills the viewport, the charts section grows to
// take all remaining height under the header.
.breakout-dialog
  width: 100%
  height: 100%
  border-color: $blue-dark

.charts
  min-height: 0
  display: flex
  flex-direction: column
  gap: 12px

// Top chart full width (analysis timeframe), bottom row split into per-second
// and tick charts. Heights come from the flex layout so all three fill the screen.
.chart-top
  flex: 1.1 1 0
  min-height: 0

.charts-bottom
  flex: 1 1 0
  min-height: 0
  display: flex
  gap: 12px

  .chart-block
    flex: 1 1 0
    min-width: 0
    min-height: 0

// Narrow viewports: stack the bottom charts instead of squeezing them.
@media (max-width: 700px)
  .charts-bottom
    flex-direction: column
</style>

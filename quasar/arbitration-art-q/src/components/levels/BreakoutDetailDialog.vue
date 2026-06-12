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
        <!-- Timeframe switch for the top (analysis-TF) chart only; the per-second
             and tick charts below are trade-based and timeframe-independent. -->
        <div
          v-if="levelsStore.timeframes.length"
          class="row items-center no-wrap q-gutter-x-xs q-mr-sm"
        >
          <q-btn
            v-for="tf in levelsStore.timeframes"
            :key="tf"
            :label="tf"
            no-caps
            dense
            unelevated
            :color="tf === topTf ? 'primary' : 'dark'"
            :text-color="tf === topTf ? 'white' : 'grey-5'"
            class="tf-btn"
            :disable="tfLoading"
            @click="setTopTf(tf)"
          />
          <q-tooltip :delay="400">Таймфрейм верхнего графика</q-tooltip>
        </div>
        <q-btn flat dense round icon="close" color="grey-5" v-close-popup />
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-section class="charts col">
        <MiniBreakoutChart
          class="chart-top"
          :title="`Пробой · ${topTf}`"
          :candles="tfCandles"
          :level-price="level"
          :level-time="levelTimeMs"
          :markers="tfMarkers"
          :loading="tfLoading"
          :error="tfError"
          :load-more="loadMoreTfHistory"
        />
        <div class="charts-bottom">
          <MiniBreakoutChart
            class="chart-block"
            title="Посекундно (по трейдам)"
            :candles="secCandles"
            :level-price="level"
            :level-time="levelTimeMs"
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
            :level-time="levelTimeMs"
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
import { useLevelsStore } from 'src/stores/levels/levels.store';
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

// Timeframe list for the top-chart switch (loaded by the detail page on mount).
const levelsStore = useLevelsStore();

// Top-chart timeframe — defaults to the analysis timeframe, switchable by the user
// (the per-second/tick charts are trade-based and ignore it). Reset on each open.
const topTf = ref(props.timeframe);

// Chart A — analysis timeframe: candles around the breakout.
const TF_LIMIT = 160;
const TF_AFTER = 40; // candles shown after the breakout for context
// Older batch size when lazy-loading top-chart history on scroll-back.
const TF_HISTORY_BATCH = 500;
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
// Level formation time (ms) — the start anchor for the level ray on each chart.
const levelTimeMs = computed(() => props.breakout?.levelTime ?? 0);
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
  // Snap the marker to the loaded bar containing the breakout: the chosen top-chart
  // timeframe need not align to breakoutCandleTime, and a candle marker must sit on
  // an existing data point to render. Candles are ascending.
  const breakSec = Math.floor(b.breakoutCandleTime / 1000);
  let markerTime = breakSec as UTCTimestamp;
  for (const c of tfCandles.value) {
    const t = c.time as number;
    if (t <= breakSec) markerTime = t as UTCTimestamp;
    else break;
  }
  return [
    {
      time: markerTime,
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
    const endTime = b.breakoutCandleTime + TF_AFTER * tfMs(topTf.value);
    tfCandles.value = await fetchKlines(props.symbol, topTf.value, TF_LIMIT, endTime);
  } catch {
    tfError.value = 'Не удалось загрузить свечи';
    tfCandles.value = [];
  } finally {
    tfLoading.value = false;
  }
}

// Switch the top chart timeframe and reload its candles around the breakout. The
// MiniBreakoutChart resets to a fresh full view on the new dataset (no double load:
// the change is driven here, not by a watcher).
function setTopTf(tf: string): void {
  if (tf === topTf.value || tfLoading.value) return;
  topTf.value = tf;
  void loadTf();
}

// Lazy-history fetcher for the top chart: older klines on the current top-chart
// timeframe ending just before the oldest loaded candle. MiniBreakoutChart prepends
// the result and keeps the visible bars in place.
function loadMoreTfHistory(oldestTimeSec: number): Promise<CandlestickData[]> {
  return fetchKlines(props.symbol, topTf.value, TF_HISTORY_BATCH, oldestTimeSec * 1000 - 1);
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

// Load all charts when the dialog opens (or the selected breakout changes). Reset
// the top-chart timeframe to the analysis timeframe for each breakout so it doesn't
// carry over a previous manual switch.
watch(
  () => [props.modelValue, props.breakout] as const,
  ([open, breakout]) => {
    if (open && breakout) {
      topTf.value = props.timeframe;
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

// Compact timeframe buttons in the header (top-chart switch).
.tf-btn
  min-width: 36px
  border-radius: 6px

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

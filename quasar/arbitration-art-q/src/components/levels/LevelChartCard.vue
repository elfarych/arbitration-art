<template>
  <q-card class="bg-dark level-card column" flat>
    <q-card-section class="q-py-sm q-px-md row items-center justify-between no-wrap level-header">
      <div
        class="row items-center no-wrap ellipsis cursor-pointer symbol-link"
        @click="emit('open', entry.symbol)"
      >
        <span class="text-title-color text-weight-bold">{{ entry.symbol }}</span>
        <span class="q-ml-sm text-grey-5 text-caption">NATR {{ entry.natr.toFixed(2) }}%</span>
        <q-tooltip :delay="400">Открыть страницу монеты</q-tooltip>
      </div>
      <div class="row items-center no-wrap q-gutter-x-sm text-caption">
        <q-chip
          v-if="entry.nearest"
          dense
          square
          size="12px"
          :color="sideColor(entry.nearest.side)"
          text-color="dark"
          class="q-ma-none text-weight-medium"
        >
          {{ nearestLabel }}
        </q-chip>
      </div>
    </q-card-section>

    <div class="col relative-position">
      <div ref="chartContainer" class="chart-container"></div>
      <div v-if="error" class="chart-overlay text-negative text-caption">{{ error }}</div>
      <div v-else-if="loading" class="chart-overlay">
        <q-spinner color="primary" size="md" />
      </div>
    </div>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type WhitespaceData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ScreenerEntry, LevelView, LevelSide } from 'src/stores/levels/api/levelsApi';
import { fetchKlines } from 'src/stores/levels/api/binanceKlines';
import { subscribeKline, type LiveCandle } from 'src/stores/levels/api/klineStream';

const props = defineProps<{ entry: ScreenerEntry; timeframe: string }>();

// Emitted when the header is clicked — the screener page navigates to the coin
// detail page. Left unhandled on the detail page itself (no re-navigation).
const emit = defineEmits<{ open: [symbol: string] }>();

// Candles shown by default; older bars lazy-load on scroll (HISTORY_BATCH).
const CANDLE_LIMIT = 400;
const HISTORY_BATCH = 500;
// Small empty gap kept to the right of the last candle (in bars).
const RIGHT_OFFSET = 8;
const SUPPORT_COLOR = '#83c764';
const RESISTANCE_COLOR = '#ff5d6b';
// Semi-transparent variants for the level rays (candles keep the solid colors).
const LEVEL_SUPPORT = 'rgba(131, 199, 100, 0.5)';
const LEVEL_RESISTANCE = 'rgba(255, 93, 107, 0.5)';
const PRICE_GRAY = '#c4c7cd';

const chartContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref('');

let chart: IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;
// Whitespace-only series reserving RIGHT_OFFSET trailing time slots for the
// right gap + ray ends. Kept separate from candleSeries so the candle series
// holds only real bars — that keeps candleSeries.update() valid on every live
// tick (update requires time >= the series' own last point).
let whitespaceSeries: ISeriesApi<'Line'> | null = null;
// Teardown for the live kline subscription (re-created on each candle reload).
let unsubscribeKline: (() => void) | null = null;
// Lazy history loading guards.
let loadingMore = false;
let noMoreHistory = false;
// One line series per level, drawn as a ray from the level's appearance time to
// the right edge. Being visible series, they also pull the price scale to
// include far-away levels (no separate anchor series needed).
let levelSeries: ISeriesApi<'Line'>[] = [];
let candles: CandlestickData[] = [];

function sideColor(side: LevelSide): string {
  return side === 'support' ? 'positive' : 'negative';
}

// lightweight-charts defaults to precision 2 / minMove 0.01, which renders
// sub-cent coins (e.g. 0.0001234) as 0 on the price axis. Derive precision and
// minMove from the coin's price magnitude so small prices show real digits.
function priceFormat() {
  const abs = Math.abs(props.entry.price);
  let precision: number;
  if (abs >= 1) precision = 2;
  else if (abs >= 0.1) precision = 4;
  else if (abs > 0) precision = Math.min(8, Math.ceil(-Math.log10(abs)) + 4);
  else precision = 2;
  return { type: 'price' as const, precision, minMove: Math.pow(10, -precision) };
}

const nearestLabel = computed(() => {
  const nearest = props.entry.nearest;
  if (!nearest) return '';
  // Side is conveyed by the chip color. Show distance in NATR and in percent;
  // NATR is null when natr is 0, then only the percent is shown.
  const pct = `${nearest.distancePct.toFixed(2)}%`;
  return nearest.distanceNatr != null
    ? `${nearest.distanceNatr.toFixed(2)} NATR · ${pct}`
    : pct;
});

function buildChart(): void {
  if (!chartContainer.value) return;
  chart = createChart(chartContainer.value, {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      // Light-gray price/time axis text.
      textColor: PRICE_GRAY,
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
    // Default is Magnet (snaps the horizontal line to candle prices); Normal
    // makes the crosshair follow the cursor freely.
    crosshair: { mode: CrosshairMode.Normal },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.08)',
      timeVisible: true,
      secondsVisible: false,
      // Right gap is provided by trailing whitespace bars in whitespaceSeries
      // (see applyWhitespace) so level rays can reach the actual right edge;
      // keep rightOffset at 0. Do NOT set fixRightEdge: it treats the trailing
      // whitespace as empty space past the most recent real candle and refuses
      // to show it, which collapses the right gap.
      rightOffset: 0,
    },
    autoSize: true,
  });

  candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: SUPPORT_COLOR,
    downColor: RESISTANCE_COLOR,
    wickUpColor: SUPPORT_COLOR,
    wickDownColor: RESISTANCE_COLOR,
    borderVisible: false,
    priceFormat: priceFormat(),
    // Neutral light-gray current-price line and its axis label.
    priceLineColor: PRICE_GRAY,
  });

  // Invisible series carrying only the trailing whitespace bars: it reserves the
  // right-edge time slots (so level rays reach the edge) without putting future
  // bars into candleSeries, where they would block incremental update().
  whitespaceSeries = chart.addSeries(LineSeries, {
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    pointMarkersVisible: false,
  });

  // Lazy-load older candles when the user scrolls/zooms past the left edge.
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (!chart || !candleSeries) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const bars = candleSeries.barsInLogicalRange(range);
    // barsBefore < 0 means the view ran past the oldest loaded candle (empty
    // space on the left) — only then fetch more, so the initial full view of
    // CANDLE_LIMIT candles doesn't auto-load extra batches on mount.
    if (bars !== null && bars.barsBefore < 0) void loadMoreHistory();
  });
}

function clearLevels(): void {
  if (!chart) return;
  for (const series of levelSeries) chart.removeSeries(series);
  levelSeries = [];
}

function applyLevels(): void {
  if (!chart || candles.length < 2) return;
  clearLevels();
  for (const level of props.entry.levels) {
    const ray = rayTimes(level);
    if (!ray) continue;
    const series = chart.addSeries(LineSeries, {
      color: level.side === 'support' ? LEVEL_SUPPORT : LEVEL_RESISTANCE,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      // No labels on levels — clean rays only. The nearest level's price/side is
      // in the card header; the price axis already shows the price grid.
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      pointMarkersVisible: false,
      priceFormat: priceFormat(),
    });
    series.setData([
      { time: ray.start, value: level.price },
      { time: ray.end, value: level.price },
    ]);
    levelSeries.push(series);
  }
}

// Timeframe (e.g. "15m", "1h") to seconds — to place trailing whitespace bars
// and the right-edge time on the same grid as the candles.
function tfSeconds(tf: string): number {
  const n = parseInt(tf, 10) || 1;
  if (tf.endsWith('h')) return n * 3600;
  if (tf.endsWith('d')) return n * 86400;
  if (tf.endsWith('w')) return n * 604800;
  return n * 60;
}

// Time at the right edge = last candle + RIGHT_OFFSET bars into the future.
function rightEdgeTime(): number {
  const lastSec = candles[candles.length - 1].time as number;
  return lastSec + RIGHT_OFFSET * tfSeconds(props.timeframe);
}

// Push the loaded candles into the candle series (real bars only) and rebuild
// the trailing whitespace. candleSeries stays free of future bars so live ticks
// can update its last bar via update(); the whitespace lives in its own series.
function setCandleData(): void {
  if (!candleSeries || candles.length === 0) return;
  candleSeries.setData([...candles]);
  applyWhitespace();
}

// RIGHT_OFFSET whitespace bars after the last candle: they make the right gap
// (candles stop short of the edge) while letting level rays reach the edge. With
// timeScale.rightOffset = 0 the last whitespace bar is the right edge.
function applyWhitespace(): void {
  if (!whitespaceSeries || candles.length === 0) return;
  const lastSec = candles[candles.length - 1].time as number;
  const interval = tfSeconds(props.timeframe);
  const future: WhitespaceData[] = [];
  for (let i = 1; i <= RIGHT_OFFSET; i++) {
    future.push({ time: (lastSec + i * interval) as UTCTimestamp });
  }
  whitespaceSeries.setData(future);
}

// A level is a horizontal ray from its appearance bar to the right edge. The
// start clamps into the loaded window (levels older than the first candle / with
// no valid time start at the left edge); the end is always the right edge.
function rayTimes(level: LevelView): { start: UTCTimestamp; end: UTCTimestamp } | null {
  if (candles.length < 2) return null;
  const firstSec = candles[0].time as number;
  const lastSec = candles[candles.length - 1].time as number;
  const rawSec = Math.floor(level.time / 1000);
  const start =
    Number.isFinite(rawSec) && rawSec >= firstSec && rawSec < lastSec ? rawSec : firstSec;
  return { start: start as UTCTimestamp, end: rightEdgeTime() as UTCTimestamp };
}

async function loadCandles(): Promise<void> {
  loading.value = true;
  error.value = '';
  noMoreHistory = false;
  loadingMore = false;
  try {
    candles = await fetchKlines(props.entry.symbol, props.timeframe, CANDLE_LIMIT);
    if (!chart) buildChart();
    setCandleData();
    applyLevels();
    // Show all loaded candles at once (plus the right gap), instead of the
    // default recent-bars view.
    chart?.timeScale().setVisibleLogicalRange({ from: 0, to: candles.length - 1 + RIGHT_OFFSET });
    // Start (or restart, on timeframe change) the live candle stream once the
    // REST snapshot is in place, so the first tick updates an existing bar.
    subscribeLive();
  } catch {
    error.value = 'Не удалось загрузить свечи';
  } finally {
    loading.value = false;
  }
}

// (Re)subscribe to the live kline stream for the current symbol+timeframe. The
// previous subscription (if any) is torn down first so a timeframe switch swaps
// streams cleanly.
function subscribeLive(): void {
  unsubscribeKline?.();
  unsubscribeKline = subscribeKline(props.entry.symbol, props.timeframe, onLiveCandle);
}

// Apply one live kline tick. The forming candle (same open time) is updated in
// place — the frequent case. A new open time means the previous candle closed:
// append the new bar, shift the trailing whitespace forward and re-extend the
// level rays to the new right edge. Older ticks are ignored.
function onLiveCandle(c: LiveCandle): void {
  if (!candleSeries || candles.length === 0) return;
  const lastSec = candles[candles.length - 1].time as number;
  const sec = c.time as number;
  if (sec < lastSec) return;
  const bar: CandlestickData = {
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
  if (sec === lastSec) {
    candles[candles.length - 1] = bar;
    candleSeries.update(bar);
  } else {
    candles.push(bar);
    candleSeries.update(bar);
    applyWhitespace();
    applyLevels();
  }
}

// Prepend an older batch of candles when scrolling near the left edge; keep the
// same bars in view by shifting the visible logical range by the added count.
async function loadMoreHistory(): Promise<void> {
  if (loadingMore || noMoreHistory || candles.length === 0) return;
  loadingMore = true;
  try {
    const oldestSec = candles[0].time as number;
    const older = await fetchKlines(
      props.entry.symbol,
      props.timeframe,
      HISTORY_BATCH,
      oldestSec * 1000 - 1,
    );
    const fresh = older.filter((c) => (c.time as number) < oldestSec);
    if (fresh.length === 0) {
      noMoreHistory = true;
      return;
    }
    const timeScale = chart?.timeScale();
    const range = timeScale?.getVisibleLogicalRange();
    const before = candles.length;
    candles = [...fresh, ...candles];
    setCandleData();
    applyLevels();
    const added = candles.length - before;
    if (timeScale && range) {
      timeScale.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
  } catch {
    // ignore — will retry on the next scroll
  } finally {
    loadingMore = false;
  }
}

onMounted(() => {
  // Wait for the container to have a size before lightweight-charts measures it.
  void nextTick(() => loadCandles());
});

// Timeframe switch reloads the candle series on the existing chart.
watch(() => props.timeframe, () => void loadCandles());

// Each poll replaces the entry object; refresh the overlaid levels in place
// without refetching candles.
watch(
  () => props.entry,
  () => {
    if (candleSeries) applyLevels();
  },
);

onBeforeUnmount(() => {
  // Stop live updates first so no tick lands on a removed chart.
  unsubscribeKline?.();
  unsubscribeKline = null;
  // chart.remove() drops all series; just reset our references.
  levelSeries = [];
  if (chart) {
    chart.remove();
    chart = null;
    candleSeries = null;
    whitespaceSeries = null;
  }
});
</script>

<style lang="sass" scoped>
.level-card
  border: 1px solid $blue-dark
  border-radius: $generic-border-radius
  overflow: hidden
  height: 100%

.level-header
  border-bottom: 1px solid $blue-dark
  min-height: 36px

// Header symbol acts as a link to the coin detail page.
.symbol-link:hover .text-title-color
  text-decoration: underline

.chart-container
  position: absolute
  inset: 0

.chart-overlay
  position: absolute
  inset: 0
  display: flex
  align-items: center
  justify-content: center
  background: rgba(14, 17, 26, 0.4)
</style>

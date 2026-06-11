<template>
  <div class="mini-chart column no-wrap">
    <div class="text-caption text-grey-5 q-mb-xs">{{ title }}</div>
    <div class="col relative-position">
      <div ref="container" class="chart-fill"></div>
      <div v-if="loading" class="overlay">
        <q-spinner color="primary" size="md" />
      </div>
      <div v-else-if="error" class="overlay text-negative text-caption">{{ error }}</div>
      <div v-else-if="!candles.length" class="overlay text-grey-5 text-caption text-center q-px-md">
        {{ emptyText ?? 'Нет данных' }}
      </div>
      <ChartRulerOverlay :measure="measure" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useChartRuler } from './useChartRuler';
import ChartRulerOverlay from './ChartRulerOverlay.vue';

const props = defineProps<{
  title: string;
  candles: CandlestickData[];
  levelPrice: number;
  markers?: SeriesMarker<UTCTimestamp>[];
  secondsVisible?: boolean;
  loading?: boolean;
  error?: string;
  emptyText?: string;
  // When provided, the chart lazy-loads older candles as the user scrolls/zooms
  // past the left edge: it calls loadMore(oldestTimeSec) and prepends the result,
  // keeping the visible bars in place. Omitted → static chart (no history paging).
  loadMore?: (oldestTimeSec: number) => Promise<CandlestickData[]>;
}>();

const container = ref<HTMLElement | null>(null);
let chart: IChartApi | null = null;
let series: ISeriesApi<'Candlestick'> | null = null;
let priceLine: IPriceLine | null = null;
let markersApi: ReturnType<typeof createSeriesMarkers> | null = null;
// Candle list actually rendered. Seeded from props.candles and, in lazy mode,
// grown at the front by loadOlder(); reset to props.candles whenever the parent
// swaps the dataset (new breakout / timeframe switch).
let data: CandlestickData[] = [...props.candles];
// Lazy history guards (only used when props.loadMore is set).
let loadingMore = false;
let noMoreHistory = false;
// Dataset generation: bumped whenever the parent swaps props.candles (timeframe
// switch / different breakout). An in-flight loadOlder() captures the generation
// before its await and bails if it changed, so it never prepends candles from the
// previous timeframe onto the new dataset.
let loadGen = 0;

// Derive precision from price magnitude so sub-cent coins don't render as 0.
function priceFormat() {
  const abs = Math.abs(props.levelPrice) || 1;
  const precision = abs >= 1 ? 2 : abs >= 0.1 ? 4 : Math.min(8, Math.ceil(-Math.log10(abs)) + 4);
  return { type: 'price' as const, precision, minMove: Math.pow(10, -precision) };
}

// Seconds per bar for the ruler's elapsed-time label. There is no single
// timeframe prop (the chart shows either analysis-TF or per-second candles), so
// derive it from the candle spacing — the median is robust to gaps in the
// per-second (aggTrade) candles.
function barSeconds(): number {
  const c = props.candles;
  const fallback = props.secondsVisible ? 1 : 60;
  if (c.length < 2) return fallback;
  const diffs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const d = (c[i].time as number) - (c[i - 1].time as number);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return fallback;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? fallback;
}

// Shift ruler overlay (see useChartRuler), shared with the screener chart card.
const { measure, attach: attachRuler, detach: detachRuler } = useChartRuler({
  container,
  chart: () => chart,
  series: () => series,
  barSeconds,
  pricePrecision: () => priceFormat().precision,
});

function build(): void {
  if (!container.value) return;
  chart = createChart(container.value, {
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#c4c7cd',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
    crosshair: { mode: CrosshairMode.Normal },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.08)',
      timeVisible: true,
      secondsVisible: !!props.secondsVisible,
    },
    autoSize: true,
  });
  series = chart.addSeries(CandlestickSeries, {
    upColor: '#83c764',
    downColor: '#ff5d6b',
    wickUpColor: '#83c764',
    wickDownColor: '#ff5d6b',
    borderVisible: false,
    priceFormat: priceFormat(),
  });

  // Lazy-load older candles when the user scrolls/zooms past the left edge
  // (opt-in via loadMore). barsBefore < 0 means the view ran past the oldest
  // loaded candle — only then fetch more, so the initial fitContent view (no empty
  // space on the left) does not auto-load extra batches.
  if (props.loadMore) {
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (!chart || !series) return;
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const bars = series.barsInLogicalRange(range);
      if (bars !== null && bars.barsBefore < 0) void loadOlder();
    });
  }

  render();
}

function render(opts?: { preserveRange?: boolean }): void {
  if (!chart || !series) return;
  series.setData([...data]);

  if (priceLine) {
    series.removePriceLine(priceLine);
    priceLine = null;
  }
  if (props.levelPrice) {
    priceLine = series.createPriceLine({
      price: props.levelPrice,
      color: '#c4c7cd',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'уровень',
    });
  }

  const markers = props.markers ?? [];
  if (!markersApi) {
    markersApi = createSeriesMarkers(series, markers);
  } else {
    markersApi.setMarkers(markers);
  }

  // Fit only on a fresh dataset; a lazy prepend keeps the current view (the caller
  // shifts the visible range by the number of bars added).
  if (data.length && !opts?.preserveRange) {
    if (props.loadMore) {
      // Lazy mode: pin the initial left edge to bar 0 (no fitContent margin) so
      // barsBefore starts at exactly 0 — otherwise a sub-bar left margin reads as
      // barsBefore < 0 and auto-loads a history batch on open.
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: data.length - 1 });
    } else {
      chart.timeScale().fitContent();
    }
  }
}

// Prepend an older batch when scrolling near the left edge, keeping the same bars
// in view by shifting the visible logical range by the number added.
async function loadOlder(): Promise<void> {
  if (!props.loadMore || loadingMore || noMoreHistory) return;
  const first = data[0];
  if (!first) return;
  loadingMore = true;
  const gen = loadGen;
  try {
    const oldestSec = first.time as number;
    const older = await props.loadMore(oldestSec);
    // Dataset was swapped (timeframe switch / different breakout) while the fetch
    // was in flight — drop this stale page so we never prepend wrong-timeframe
    // candles onto the new dataset.
    if (gen !== loadGen) return;
    const fresh = older.filter((c) => (c.time as number) < oldestSec);
    if (fresh.length === 0) {
      noMoreHistory = true;
      return;
    }
    const ts = chart?.timeScale();
    const range = ts?.getVisibleLogicalRange();
    const before = data.length;
    data = [...fresh, ...data];
    render({ preserveRange: true });
    const added = data.length - before;
    if (ts && range) {
      ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
  } catch {
    // ignore — will retry on the next scroll
  } finally {
    // Only release the guard if we still own the current dataset; a swap already
    // reset it for the new dataset and may have a newer loadOlder in flight.
    if (gen === loadGen) loadingMore = false;
  }
}

onMounted(() => {
  // Enable the Shift ruler once the container exists (chart is built lazily).
  attachRuler();
  void nextTick(() => build());
});

// Rebuild data when the parent swaps the dataset (dialog reused for a different
// breakout, or the top-chart timeframe switched). Resets the lazy-history state and
// re-fits, so a new dataset starts from a clean full view.
watch(
  () => props.candles,
  () => {
    data = [...props.candles];
    loadingMore = false;
    noMoreHistory = false;
    // Invalidate any in-flight loadOlder() bound to the previous dataset.
    loadGen++;
    if (!chart) build();
    else render();
  },
);

onBeforeUnmount(() => {
  // Drop the ruler (and any window listeners) before the chart is removed.
  detachRuler();
  if (chart) {
    chart.remove();
    chart = null;
    series = null;
    priceLine = null;
    markersApi = null;
  }
});
</script>

<style lang="sass" scoped>
.mini-chart
  height: 100%

.chart-fill
  position: absolute
  inset: 0

.overlay
  position: absolute
  inset: 0
  display: flex
  align-items: center
  justify-content: center
  background: rgba(14, 17, 26, 0.4)
</style>

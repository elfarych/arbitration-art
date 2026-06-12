<template>
  <div class="mini-chart column no-wrap">
    <div class="text-caption text-grey-5 q-mb-xs">{{ title }}</div>
    <div class="col relative-position">
      <div ref="container" class="chart-fill"></div>
      <div v-if="loading" class="overlay">
        <q-spinner color="primary" size="md" />
      </div>
      <div v-else-if="error" class="overlay text-negative text-caption">{{ error }}</div>
      <div v-else-if="!points.length" class="overlay text-grey-5 text-caption text-center q-px-md">
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
  LineSeries,
  createSeriesMarkers,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useChartRuler } from './useChartRuler';
import ChartRulerOverlay from './ChartRulerOverlay.vue';

const props = defineProps<{
  title: string;
  points: LineData[];
  levelPrice: number;
  // Level formation time (ms). The level is drawn as a ray from here to the right
  // edge; on this tick window it always predates the data, so the ray clamps to the
  // left edge (full-width). Omitted/0 → full-width.
  levelTime?: number;
  markers?: SeriesMarker<UTCTimestamp>[];
  loading?: boolean;
  error?: string;
  emptyText?: string;
}>();

const container = ref<HTMLElement | null>(null);
let chart: IChartApi | null = null;
let series: ISeriesApi<'Line'> | null = null;
// Level drawn as a ray (separate 2-point line series) instead of a price line.
let levelRay: ISeriesApi<'Line'> | null = null;
let markersApi: ReturnType<typeof createSeriesMarkers> | null = null;

// Derive precision from price magnitude so sub-cent coins don't render as 0.
function priceFormat() {
  const abs = Math.abs(props.levelPrice) || 1;
  const precision = abs >= 1 ? 2 : abs >= 0.1 ? 4 : Math.min(8, Math.ceil(-Math.log10(abs)) + 4);
  return { type: 'price' as const, precision, minMove: Math.pow(10, -precision) };
}

// Seconds per point for the ruler's elapsed-time label. Ticks are irregular, so
// take the median spacing (sub-second values are expected).
function barSeconds(): number {
  const p = props.points;
  if (p.length < 2) return 1;
  const diffs: number[] = [];
  for (let i = 1; i < p.length; i++) {
    const d = (p[i].time as number) - (p[i - 1].time as number);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? 1;
}

// Shift ruler overlay (see useChartRuler), shared with the candle charts.
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
      // Ticks live at sub-second resolution — show seconds on the axis.
      secondsVisible: true,
    },
    autoSize: true,
  });
  series = chart.addSeries(LineSeries, {
    color: '#4c5cf9',
    lineWidth: 1,
    priceFormat: priceFormat(),
    // No current-price line/label — the only reference line is the level ray below.
    lastValueVisible: false,
    priceLineVisible: false,
  });
  // Level ray: thin dashed line at the level price across the window. Own price
  // line/label hidden so it reads as a clean ray.
  levelRay = chart.addSeries(LineSeries, {
    color: '#c4c7cd',
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    priceFormat: priceFormat(),
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  render();
}

function render(): void {
  if (!chart || !series) return;
  series.setData([...props.points]);
  renderLevelRay();

  const markers = props.markers ?? [];
  if (!markersApi) {
    markersApi = createSeriesMarkers(series, markers);
  } else {
    markersApi.setMarkers(markers);
  }

  if (props.points.length) {
    chart.timeScale().fitContent();
  }
}

// Draw the level as a 2-point ray spanning the tick window at the level price. The
// formation time predates this window, so it clamps to the left edge; the ray runs
// to the last tick. Empty when there's no level or too few points to span.
function renderLevelRay(): void {
  if (!levelRay) return;
  const points = props.points;
  if (!props.levelPrice || points.length < 2) {
    levelRay.setData([]);
    return;
  }
  const firstT = points[0].time as number;
  const lastT = points[points.length - 1].time as number;
  const startSec = props.levelTime ? props.levelTime / 1000 : firstT;
  const start = startSec >= lastT ? firstT : Math.max(startSec, firstT);
  levelRay.setData([
    { time: start as UTCTimestamp, value: props.levelPrice },
    { time: lastT as UTCTimestamp, value: props.levelPrice },
  ]);
}

onMounted(() => {
  // Enable the Shift ruler once the container exists (chart is built lazily).
  attachRuler();
  void nextTick(() => build());
});

// Rebuild data when inputs change (dialog reused for a different breakout).
watch(
  () => props.points,
  () => {
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
    levelRay = null;
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

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
  type IPriceLine,
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
  markers?: SeriesMarker<UTCTimestamp>[];
  loading?: boolean;
  error?: string;
  emptyText?: string;
}>();

const container = ref<HTMLElement | null>(null);
let chart: IChartApi | null = null;
let series: ISeriesApi<'Line'> | null = null;
let priceLine: IPriceLine | null = null;
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
  });
  render();
}

function render(): void {
  if (!chart || !series) return;
  series.setData([...props.points]);

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

  if (props.points.length) {
    chart.timeScale().fitContent();
  }
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

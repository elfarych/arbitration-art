import { ref, type Ref } from 'vue';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';

// Display state for the Shift ruler overlay (TradingView-style measure). The
// host component renders a box (boxStyle) and a label (labelStyle + texts) over
// the chart container while `measure` is non-null.
export interface RulerMeasure {
  bullish: boolean;
  boxStyle: Record<string, string>;
  labelStyle: Record<string, string>;
  priceText: string;
  metaText: string;
}

interface RulerOptions {
  // Chart container element; the overlay is rendered as its sibling.
  container: Ref<HTMLElement | null>;
  // Chart and price series are built after mount — resolve them lazily.
  // coordinateToPrice is shared by candle and line series, so either works.
  chart: () => IChartApi | null;
  series: () => ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null;
  // Seconds represented by one bar (elapsed-time label) and the number of price
  // decimals (delta formatting). Both depend on the host's current data.
  barSeconds: () => number;
  pricePrecision: () => number;
}

// Human-readable elapsed time for the ruler label (up to two units).
function formatDuration(totalSeconds: number): string {
  let s = totalSeconds;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}д`);
  if (h > 0) parts.push(`${h}ч`);
  if (m > 0 && d === 0) parts.push(`${m}м`);
  return parts.length > 0 ? parts.join(' ') : '<1м';
}

// Shift turns a lightweight-charts chart into a TradingView-style ruler with a
// two-click flow (the mouse button is NOT held): first shift+click anchors the
// start, the end then follows the cursor on mouse move, a second shift+click
// freezes the span. The ruler lives only while Shift is held — releasing Shift
// or pressing Escape clears it. Capturing the mousedown and calling
// stopPropagation keeps the click off the chart canvas so the chart does not
// pan. Call attach() once the container is mounted, detach() before the chart
// is removed.
export function useChartRuler(opts: RulerOptions) {
  const measure = ref<RulerMeasure | null>(null);
  // Ruler start anchor in container pixels; set on the first shift+click.
  let startPx: { x: number; y: number } | null = null;
  // True between the first and second shift+click: the end follows the cursor.
  let tracking = false;

  // Recompute the overlay from the anchor to the current pointer. Pixel
  // coordinates are converted to data via the chart APIs: logical index for the
  // bar count, series price for the delta. The pointer is clamped to the chart
  // area so the box stays inside and the conversion never runs past the range.
  function update(rawX: number, rawY: number): void {
    const chart = opts.chart();
    const series = opts.series();
    const el = opts.container.value;
    if (!startPx || !chart || !series || !el) return;
    const rect = el.getBoundingClientRect();
    const endX = Math.max(0, Math.min(rawX, rect.width));
    const endY = Math.max(0, Math.min(rawY, rect.height));
    const ts = chart.timeScale();
    const startLogical = ts.coordinateToLogical(startPx.x);
    const endLogical = ts.coordinateToLogical(endX);
    const startPrice = series.coordinateToPrice(startPx.y);
    const endPrice = series.coordinateToPrice(endY);
    if (startLogical === null || endLogical === null || startPrice === null || endPrice === null) {
      return;
    }
    const bars = Math.round(Math.abs(endLogical - startLogical));
    const seconds = bars * opts.barSeconds();
    const diff = endPrice - startPrice;
    const pct = startPrice !== 0 ? (diff / startPrice) * 100 : 0;
    const precision = opts.pricePrecision();
    const left = Math.min(startPx.x, endX);
    const top = Math.min(startPx.y, endY);
    const width = Math.abs(endX - startPx.x);
    const height = Math.abs(endY - startPx.y);
    const centerX = left + width / 2;
    // Default the label above the box; flip below when there is no room on top.
    const labelBelow = top < 30;
    measure.value = {
      bullish: diff >= 0,
      boxStyle: {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      },
      labelStyle: {
        left: `${centerX}px`,
        top: `${top}px`,
        transform: labelBelow ? 'translate(-50%, 6px)' : 'translate(-50%, calc(-100% - 6px))',
      },
      priceText: `${diff >= 0 ? '+' : ''}${diff.toFixed(precision)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
      metaText: `${bars} бар. · ${formatDuration(seconds)}`,
    };
  }

  function onMouseDown(e: MouseEvent): void {
    if (!e.shiftKey || e.button !== 0) return;
    const el = opts.container.value;
    if (!opts.chart() || !opts.series() || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!tracking) {
      // First click (or re-anchor after a freeze): start a new measurement.
      startPx = point;
      tracking = true;
      el.style.cursor = 'crosshair';
      update(point.x, point.y);
      // addEventListener dedupes identical handlers, so re-anchoring is a no-op.
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('keydown', onKeyDown);
    } else {
      // Second click: freeze the end at this point.
      tracking = false;
      update(point.x, point.y);
    }
  }

  // While tracking, the end follows the cursor (no button pressed). Releasing
  // Shift mid-move clears the ruler.
  function onMouseMove(e: MouseEvent): void {
    if (!tracking || !startPx || !opts.container.value) return;
    if (!e.shiftKey) {
      clear();
      return;
    }
    const rect = opts.container.value.getBoundingClientRect();
    update(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') clear();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') clear();
  }

  function clear(): void {
    if (!tracking && !startPx && !measure.value) return;
    tracking = false;
    startPx = null;
    measure.value = null;
    if (opts.container.value) opts.container.value.style.cursor = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('keydown', onKeyDown);
  }

  function attach(): void {
    // Capture phase so the ruler intercepts shift+mousedown before the chart canvas.
    opts.container.value?.addEventListener('mousedown', onMouseDown, true);
  }

  function detach(): void {
    opts.container.value?.removeEventListener('mousedown', onMouseDown, true);
    clear();
  }

  return { measure, attach, detach };
}

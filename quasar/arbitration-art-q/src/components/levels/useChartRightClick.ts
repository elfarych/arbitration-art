import type { Ref } from 'vue';
import type { ISeriesApi } from 'lightweight-charts';

// Right-click on the chart → price under the cursor → immediate callback (no
// confirmation menu). The Y pixel (relative to the container) is turned into a
// price via the series' `coordinateToPrice` (same approach as useChartRuler).
// The handler runs in the capture phase and calls preventDefault so the native
// context menu does not appear.

interface Options {
  // Chart container element.
  container: Ref<HTMLElement | null>;
  // Price series is built after mount — resolve lazily. coordinateToPrice is
  // shared by candle and line series, so either works.
  series: () => ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null;
  // Called with the price under the cursor on right-click (skipped if the click
  // is outside the chart's price range).
  onPick: (price: number) => void;
}

export function useChartRightClick(opts: Options) {
  function onContextMenu(e: MouseEvent): void {
    const series = opts.series();
    const el = opts.container.value;
    if (!series || !el) return;
    const rect = el.getBoundingClientRect();
    const price = series.coordinateToPrice(e.clientY - rect.top);
    if (price === null) return;
    e.preventDefault();
    opts.onPick(price);
  }

  function attach(): void {
    opts.container.value?.addEventListener('contextmenu', onContextMenu, true);
  }

  function detach(): void {
    opts.container.value?.removeEventListener('contextmenu', onContextMenu, true);
  }

  return { attach, detach };
}

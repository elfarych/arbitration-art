<template>
  <!-- HTML overlay over the chart: one badge per armed price notification, sitting
       on the left end of its (lightweight-charts) dashed line. The line itself is
       a LineSeries (tracks the price scale natively); this overlay carries the
       interactive bits — bell, price, delete, drag handle. Container is
       pointer-events:none; only the badges capture events. -->
  <div class="pn-overlay">
    <div
      v-for="marker in markers"
      :key="marker.id"
      class="pn-marker"
      :style="{ top: `${marker.top}px` }"
    >
      <div
        class="pn-badge"
        :class="{ 'pn-dragging': marker.id === draggingId }"
        @mousedown.left.stop.prevent="emit('drag-start', marker.id, $event)"
      >
        <q-icon name="notifications" size="13px" class="pn-bell" />
        <span class="pn-price">{{ marker.label }}</span>
        <q-icon
          name="close"
          size="13px"
          class="pn-close"
          @mousedown.stop
          @click.stop="emit('delete', marker.id)"
        >
          <q-tooltip :delay="300">Удалить уведомление</q-tooltip>
        </q-icon>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// Exported separately (a named type export is not allowed inside <script setup>).
export interface PriceNotificationMarker {
  id: number;
  // Vertical position in chart-container pixels (from priceToCoordinate).
  top: number;
  // Preformatted target price.
  label: string;
}
</script>

<script setup lang="ts">
defineProps<{
  markers: PriceNotificationMarker[];
  // Id currently being dragged (for styling); null when idle.
  draggingId: number | null;
}>();

const emit = defineEmits<{
  delete: [id: number];
  'drag-start': [id: number, event: MouseEvent];
}>();
</script>

<style lang="sass" scoped>
.pn-overlay
  position: absolute
  inset: 0
  pointer-events: none
  overflow: hidden
  // Above the lightweight-charts canvases (incl. the transparent top/crosshair
  // canvas) so the badges actually receive clicks and drag, not just paint.
  z-index: 5

.pn-marker
  position: absolute
  left: 4px
  transform: translateY(-50%)

.pn-badge
  display: inline-flex
  align-items: center
  gap: 3px
  height: 18px
  padding: 0 4px 0 5px
  border-radius: 4px
  background: rgba(20, 23, 34, 0.9)
  border: 1px solid #f5c542
  color: #f5c542
  font-size: 11px
  font-weight: 600
  line-height: 1
  cursor: ns-resize
  pointer-events: auto
  user-select: none
  white-space: nowrap

.pn-badge.pn-dragging
  background: rgba(245, 197, 66, 0.18)

.pn-bell
  flex: none

.pn-price
  color: #e7e9ee

.pn-close
  flex: none
  cursor: pointer
  border-radius: 50%
  color: $grey-5
  &:hover
    color: $negative
</style>

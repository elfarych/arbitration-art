<template>
  <template v-if="measure">
    <div
      class="measure-box"
      :class="measure.bullish ? 'measure-up' : 'measure-down'"
      :style="measure.boxStyle"
    ></div>
    <div
      class="measure-label"
      :class="measure.bullish ? 'measure-up' : 'measure-down'"
      :style="measure.labelStyle"
    >
      <div class="text-weight-bold">{{ measure.priceText }}</div>
      <div>{{ measure.metaText }}</div>
    </div>
  </template>
</template>

<script setup lang="ts">
import type { RulerMeasure } from './useChartRuler';

// Presentational overlay for the Shift ruler (see useChartRuler). Rendered inside
// a chart's relative-positioned container; both elements are click-through so
// they never block chart interaction. Shared by every levels chart component.
defineProps<{ measure: RulerMeasure | null }>();
</script>

<style lang="sass" scoped>
.measure-box
  position: absolute
  pointer-events: none
  border: 1px solid
  z-index: 5
  &.measure-up
    background: rgba(131, 199, 100, 0.12)
    border-color: rgba(131, 199, 100, 0.7)
  &.measure-down
    background: rgba(255, 93, 107, 0.12)
    border-color: rgba(255, 93, 107, 0.7)

.measure-label
  position: absolute
  pointer-events: none
  padding: 2px 6px
  border-radius: 3px
  font-size: 11px
  line-height: 1.3
  text-align: center
  white-space: nowrap
  color: #0e111a
  z-index: 6
  &.measure-up
    background: #83c764
  &.measure-down
    background: #ff5d6b
</style>

<template>
  <q-btn unelevated no-caps dense color="dark" text-color="grey-5" class="grid-picker-btn q-px-sm">
    <q-icon name="grid_view" size="18px" class="q-mr-xs" />
    <span>{{ columns }} × {{ rows }}</span>
    <q-icon name="arrow_drop_down" size="18px" />

    <q-menu anchor="bottom right" self="top right" class="bg-dark grid-picker-menu">
      <div class="grid-picker q-pa-sm" @mouseleave="hover = null">
        <div v-for="r in max" :key="r" class="row no-wrap">
          <div
            v-for="c in max"
            :key="c"
            v-close-popup
            class="grid-cell"
            :class="{ active: isActive(c, r) }"
            @mouseenter="hover = { c, r }"
            @click="select(c, r)"
          />
        </div>
        <div class="text-center text-caption text-grey-5 q-mt-xs">{{ label }}</div>
      </div>
    </q-menu>
  </q-btn>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = withDefaults(
  defineProps<{ columns: number; rows: number; max?: number }>(),
  { max: 5 },
);

const emit = defineEmits<{ (e: 'select', value: { columns: number; rows: number }): void }>();

// Cell under the cursor during preview; null falls back to the current selection.
const hover = ref<{ c: number; r: number } | null>(null);

const previewCols = computed(() => hover.value?.c ?? props.columns);
const previewRows = computed(() => hover.value?.r ?? props.rows);

const label = computed(() => `${previewCols.value} × ${previewRows.value}`);

function isActive(c: number, r: number): boolean {
  return c <= previewCols.value && r <= previewRows.value;
}

function select(c: number, r: number): void {
  emit('select', { columns: c, rows: r });
}
</script>

<style lang="sass" scoped>
.grid-picker-btn
  border-radius: 6px

.grid-cell
  width: 22px
  height: 22px
  margin: 2px
  border: 1px solid $blue-dark
  border-radius: 3px
  cursor: pointer
  transition: background-color 0.1s ease, border-color 0.1s ease
  &.active
    background-color: $warning
    border-color: $warning
</style>

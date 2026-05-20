<template>
  <div class="widget-top-list">
    <div v-if="error" class="q-pa-md text-negative text-caption">
      {{ error }}
    </div>
    <div v-else-if="rows.length === 0" class="q-pa-md text-grey-5 text-caption">
      Нет данных. Подожди обновления или нажми «Обновить».
    </div>
    <q-scroll-area v-else class="widget-top-list__scroll">
      <div class="row no-wrap items-center text-caption text-grey-6 q-px-md q-py-xs widget-top-list__head">
        <div class="col-1">#</div>
        <div class="col">Монета</div>
        <div class="col-3 text-right">Объём 24ч</div>
        <div class="col-3 text-right">Спред</div>
        <div class="col-2 text-right">В топе</div>
      </div>
      <div
        v-for="row in rows"
        :key="row.coin"
        class="row no-wrap items-center q-px-md q-py-sm widget-top-list__row"
      >
        <div class="col-1 text-grey-5 text-caption">{{ row.position }}</div>
        <div class="col">
          <div class="text-weight-bold text-title-color">{{ row.coin }}</div>
          <div class="text-caption text-grey-6">
            {{ formatPrice(row.primaryPrice) }} / {{ formatPrice(row.secondaryPrice) }}
          </div>
        </div>
        <div class="col-3 text-right">
          <div class="text-caption text-grey-3">{{ formatVolume(row.minQuoteVolume) }}</div>
          <q-tooltip v-if="row.minQuoteVolume > 0" class="bg-dark text-grey-3" :offset="[0, 4]">
            min(primary, secondary) 24h turnover
          </q-tooltip>
        </div>
        <div class="col-3 text-right">
          <span :class="spreadClass(row.spread)">
            {{ row.spread > 0 ? '+' : '' }}{{ row.spread.toFixed(3) }}%
          </span>
        </div>
        <div class="col-2 text-right">
          <q-badge :color="row.appearances > 1 ? 'primary' : 'grey-8'" :text-color="row.appearances > 1 ? 'white' : 'grey-3'">
            ×{{ row.appearances }}
          </q-badge>
        </div>
      </div>
    </q-scroll-area>
  </div>
</template>

<script setup lang="ts">
import type { WidgetResult } from 'src/stores/screener/screenerWidget.store';

defineProps<{
  rows: WidgetResult[];
  error: string | null;
}>();

const formatPrice = (v: number): string => {
  if (!v || v <= 0) return '—';
  if (v < 1) return v.toFixed(5);
  if (v < 100) return v.toFixed(3);
  return v.toFixed(2);
};

const formatVolume = (v: number): string => {
  if (!v || v <= 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

const spreadClass = (s: number) => {
  if (s > 0.5) return 'text-positive text-weight-bold';
  if (s > 0) return 'text-positive';
  return 'text-negative';
};
</script>

<style lang="sass" scoped>
.widget-top-list
  display: flex
  flex-direction: column
  min-height: 0
  flex: 1 1 auto

.widget-top-list__scroll
  height: 360px

.widget-top-list__head
  border-bottom: 1px solid $blue-dark
  text-transform: uppercase
  letter-spacing: 0.04em
  position: sticky
  top: 0
  background: $dark
  z-index: 1

.widget-top-list__row
  border-bottom: 1px solid rgba(255, 255, 255, 0.04)
  transition: background-color 0.15s ease
  &:hover
    background-color: rgba(255, 255, 255, 0.03)
</style>

<template>
  <q-card flat bordered class="pnl-stat-card bg-dark border-dark q-pa-md">
    <div class="row items-center justify-between q-mb-xs">
      <span class="text-caption opacity-70 text-weight-medium">{{ title }}</span>
      <q-icon v-if="icon" :name="icon" size="16px" class="opacity-50" />
    </div>
    <div v-if="loading" class="row items-center q-gutter-x-sm" style="min-height: 32px">
      <q-skeleton type="rect" width="100px" height="24px" class="bg-grey-9" />
    </div>
    <div v-else class="row items-baseline q-gutter-x-sm" style="min-height: 32px">
      <span class="text-h6 text-weight-bold" :class="colorClass" style="line-height: 1.1">{{ value }}</span>
      <span v-if="unit" class="text-caption opacity-50">{{ unit }}</span>
    </div>
  </q-card>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  value: string;
  unit?: string;
  colorClass?: string;
  loading?: boolean;
  icon?: string;
}>();
</script>

<style lang="sass" scoped>
.pnl-stat-card
  border-radius: $generic-border-radius

.border-dark
  border-color: $blue-dark

.opacity-70
  opacity: 0.7
.opacity-50
  opacity: 0.5
</style>

<template>
  <div class="analyses-list column no-wrap">
    <div v-if="loading && !items.length" class="flex flex-center q-pa-lg">
      <q-spinner color="primary" size="md" />
    </div>

    <div v-else-if="!items.length" class="text-center text-grey-5 q-pa-lg">
      Анализов пока нет — запустите первый кнопкой «Анализ»
    </div>

    <template v-else>
      <div class="row items-center analyses-head text-caption text-grey-5">
        <div class="cell cell-time">Время</div>
        <div class="cell cell-tf">ТФ</div>
        <div class="cell cell-dir">Пробитие</div>
        <div class="cell cell-num">Найдено</div>
        <div class="cell cell-num">Совпало</div>
        <div class="cell cell-num">Match</div>
        <div class="cell cell-act"></div>
      </div>

      <div class="analyses-rows col scroll">
        <div
          v-for="a in items"
          :key="a.id"
          class="row items-center analysis-row"
          :class="{ active: a.id === selectedId }"
          @click="emit('select', a.id)"
        >
          <div class="cell cell-time">
            {{ fmtTime(a.createdAt) }}
            <q-tooltip :delay="400">{{ paramsLabel(a) }}</q-tooltip>
          </div>
          <div class="cell cell-tf">{{ a.timeframe }}</div>
          <div class="cell cell-dir" :class="dirClass(a.params.direction)">
            {{ dirLabel(a.params.direction) }}
          </div>
          <div class="cell cell-num">{{ a.summary.breakoutsFound }}</div>
          <div class="cell cell-num text-positive">
            {{ a.summary.matched }}/{{ a.summary.evaluated }}
          </div>
          <div class="cell cell-num text-primary">
            {{ (a.summary.matchRate * 100).toFixed(1) }}%
          </div>
          <div class="cell cell-act">
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="delete_outline"
              color="grey-6"
              @click.stop="emit('remove', a.id)"
            >
              <q-tooltip>Удалить анализ</q-tooltip>
            </q-btn>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { SavedAnalysis } from 'src/stores/levels/api/analysisApi';
import type { BreakoutDirection } from 'src/stores/levels/api/levelsApi';

defineProps<{
  items: SavedAnalysis[];
  loading: boolean;
  selectedId: number | null;
}>();

const emit = defineEmits<{ select: [id: number]; remove: [id: number] }>();

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const DIR_LABELS: Record<BreakoutDirection, string> = {
  up: '▲ вверх',
  down: '▼ вниз',
  both: 'оба',
};

function dirLabel(direction: BreakoutDirection): string {
  return DIR_LABELS[direction] ?? direction;
}

function dirClass(direction: BreakoutDirection): string {
  if (direction === 'up') return 'text-positive';
  if (direction === 'down') return 'text-negative';
  return 'text-grey-4';
}

function paramsLabel(a: SavedAnalysis): string {
  const p = a.params;
  return `погрешность ${p.natrMultiplier} NATR · gap ${p.minGap} · ${p.candles} свечей · макс ${p.maxBreakoutSeconds}с · мин ${p.minMovePct}%`;
}
</script>

<style lang="sass" scoped>
.analyses-list
  border: 1px solid $blue-dark
  border-radius: $generic-border-radius
  overflow: hidden

.analyses-head
  padding: 6px 12px
  border-bottom: 1px solid $blue-dark

.analyses-rows
  max-height: 320px

.analysis-row
  padding: 8px 12px
  border-bottom: 1px solid rgba(255, 255, 255, 0.04)
  cursor: pointer

  &:hover
    background: rgba(255, 255, 255, 0.03)

  &.active
    background: rgba(76, 92, 249, 0.16)

.cell
  padding-right: 8px
  white-space: nowrap
  overflow: hidden
  text-overflow: ellipsis

.cell-time
  flex: 0 0 110px

.cell-tf
  flex: 0 0 48px

.cell-dir
  flex: 0 0 80px

.cell-num
  flex: 1 1 0
  text-align: right

.cell-act
  flex: 0 0 40px
  text-align: right
</style>

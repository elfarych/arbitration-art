<template>
  <div class="column no-wrap">
    <div v-if="loading" class="flex flex-center column q-pa-xl text-grey-5">
      <q-spinner color="primary" size="lg" />
      <div class="q-mt-md text-caption">
        Анализ может занять время — по каждому пробою запрашиваются трейды Binance
      </div>
    </div>

    <q-banner v-else-if="error" dense class="bg-negative text-white rounded-borders">
      {{ error }}
    </q-banner>

    <div v-else-if="!result" class="text-center text-grey-5 q-pa-xl">
      Нажмите «Анализ», чтобы найти и проверить пробои уровней
    </div>

    <template v-else>
      <div class="row q-col-gutter-sm q-mb-md">
        <div v-for="tile in tiles" :key="tile.label" class="col">
          <div class="stat-tile bg-dark rounded-borders q-pa-sm">
            <div class="text-caption text-grey-5">{{ tile.label }}</div>
            <div
              class="text-subtitle1 text-weight-bold"
              :class="tile.color ? `text-${tile.color}` : ''"
            >
              {{ tile.value }}
            </div>
          </div>
        </div>
      </div>

      <div class="text-caption text-grey-5 q-mb-sm">
        {{ result.candlesAnalyzed }} свечей · {{ rangeLabel }}
      </div>

      <q-table
        :rows="result.breakouts"
        :columns="columns"
        row-key="breakoutCandleTime"
        dense
        flat
        dark
        :rows-per-page-options="[20, 50, 100, 0]"
        :pagination="{ rowsPerPage: 20 }"
        class="bg-dark analysis-table clickable-rows"
        @row-click="onRowClick"
      >
        <template #body-cell-dir="cellProps">
          <q-td :props="cellProps">
            <span :class="cellProps.row.direction === 'up' ? 'text-positive' : 'text-negative'">
              {{ cellProps.row.direction === 'up' ? '▲ вверх' : '▼ вниз' }}
            </span>
          </q-td>
        </template>

        <template #body-cell-status="cellProps">
          <q-td :props="cellProps">
            <q-chip
              dense
              square
              size="11px"
              :color="cellProps.row.matched ? 'positive' : 'grey-8'"
              :text-color="cellProps.row.matched ? 'dark' : 'grey-4'"
              class="q-ma-none text-weight-medium"
            >
              {{ reasonLabel(cellProps.row.reason) }}
            </q-chip>
          </q-td>
        </template>
      </q-table>
    </template>

    <BreakoutDetailDialog
      v-model="detailOpen"
      :symbol="result?.symbol ?? ''"
      :timeframe="result?.timeframe ?? ''"
      :max-breakout-seconds="result?.params.maxBreakoutSeconds ?? 0"
      :breakout="selected"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { QTableColumn } from 'quasar';
import type { AnalysisResult, AnalysisBreakout } from 'src/stores/levels/api/levelsApi';
import BreakoutDetailDialog from './BreakoutDetailDialog.vue';

const props = defineProps<{
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
}>();

// Clicking a breakout row opens the detail dialog (two charts: analysis TF + per-second).
const detailOpen = ref(false);
const selected = ref<AnalysisBreakout | null>(null);

function onRowClick(_evt: Event, row: AnalysisBreakout) {
  selected.value = row;
  detailOpen.value = true;
}

// Summary stat tiles derived from the result (rendered as a row of cards).
const tiles = computed<Array<{ label: string; value: string; color?: string }>>(() => {
  const r = props.result;
  if (!r) return [];
  const { summary } = r;
  return [
    { label: 'Найдено пробоев', value: String(summary.breakoutsFound) },
    { label: 'Проверено / совпало', value: `${summary.evaluated} / ${summary.matched}`, color: 'positive' },
    { label: 'Match rate', value: `${(summary.matchRate * 100).toFixed(1)}%`, color: 'primary' },
    {
      label: 'Вверх / Вниз',
      value: `${summary.byDirection.up.matched}/${summary.byDirection.up.found} · ${summary.byDirection.down.matched}/${summary.byDirection.down.found}`,
    },
  ];
});

const rangeLabel = computed(() => {
  if (!props.result) return '';
  return `${fmtTime(props.result.range.from)} — ${fmtTime(props.result.range.to)}`;
});

const columns: QTableColumn<AnalysisBreakout>[] = [
  {
    name: 'time',
    label: 'Время пробоя',
    field: 'breakoutCandleTime',
    align: 'left',
    sortable: true,
    format: (v) => fmtTime(v as number),
  },
  { name: 'dir', label: 'Сторона', field: 'direction', align: 'left', sortable: true },
  {
    name: 'price',
    label: 'Цена уровня',
    field: 'price',
    align: 'right',
    sortable: true,
    format: (v) => fmtPrice(v as number),
  },
  { name: 'touches', label: 'Касаний', field: 'touches', align: 'right', sortable: true },
  {
    name: 'move',
    label: 'Движение',
    field: 'movePct',
    align: 'right',
    sortable: true,
    format: (v) => fmtPct(v as number | null),
  },
  {
    name: 'elapsed',
    label: 'За время',
    field: 'elapsedMs',
    align: 'right',
    sortable: true,
    format: (v) => fmtElapsed(v as number | null),
  },
  { name: 'status', label: 'Статус', field: 'matched', align: 'center', sortable: true },
];

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : abs >= 0.1 ? 4 : Math.min(8, Math.ceil(-Math.log10(abs || 1)) + 4);
  return n.toFixed(digits);
}

function fmtPct(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(2)}%`;
}

function fmtElapsed(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} с`;
}

const REASON_LABELS: Record<string, string> = {
  ok: 'соответствует',
  no_trades: 'нет трейдов',
  no_cross: 'нет трейда за уровнем',
  min_move_not_reached: 'движение мало',
  too_slow: 'слишком долго',
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}
</script>

<style lang="sass" scoped>
.stat-tile
  border: 1px solid $blue-dark

.analysis-table
  border: 1px solid $blue-dark
  border-radius: $generic-border-radius

// Rows open the breakout detail dialog on click.
.clickable-rows :deep(tbody tr)
  cursor: pointer

  &:hover
    background: rgba(255, 255, 255, 0.03)
</style>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="bg-dark text-white analysis-dialog" flat bordered>
      <q-card-section class="row items-center no-wrap q-py-sm">
        <q-icon name="analytics" size="22px" color="primary" class="q-mr-sm" />
        <span class="text-subtitle1 text-weight-bold">Настройки анализа</span>
        <q-space />
        <q-btn flat dense round icon="close" color="grey-5" v-close-popup />
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-section class="q-gutter-y-md">
        <!-- Окно: что и сколько грузим -->
        <div>
          <div class="group-label">Окно анализа</div>
          <div class="row q-col-gutter-sm">
            <q-select
              v-model="form.timeframe"
              :options="timeframes"
              label="Таймфрейм"
              dense
              outlined
              dark
              options-dense
              class="col-6"
            />
            <q-input
              v-model.number="form.candles"
              type="number"
              label="Свечей для анализа"
              :min="61"
              step="100"
              dense
              outlined
              dark
              class="col-6"
              hint="от 61"
            />
          </div>
        </div>

        <!-- Уровни: как ищем уровень -->
        <div>
          <div class="group-label">Поиск уровней</div>
          <q-btn-toggle
            v-model="form.toleranceMode"
            :options="TOLERANCE_OPTIONS"
            spread
            no-caps
            unelevated
            dense
            toggle-color="primary"
            color="dark"
            text-color="grey-5"
            class="tolerance-toggle q-mb-sm"
          />
          <div class="row q-col-gutter-sm">
            <q-input
              v-model.number="tol"
              type="number"
              label="Погрешность"
              :suffix="form.toleranceMode === 'pct' ? '%' : 'NATR'"
              step="0.05"
              min="0"
              dense
              outlined
              dark
              class="col-6"
              :hint="form.toleranceMode === 'pct' ? 'ширина зоны = ±значение%' : ''"
            />
            <q-input
              v-model.number="form.minGap"
              type="number"
              label="Свечей между касаниями"
              step="1"
              min="1"
              dense
              outlined
              dark
              class="col-6"
              :hint="gapHint"
            />
          </div>
        </div>

        <!-- Пробой: критерий подтверждения по трейдам -->
        <div>
          <div class="group-label">Критерий пробоя</div>
          <q-btn-toggle
            v-model="form.direction"
            :options="DIRECTION_OPTIONS"
            spread
            no-caps
            unelevated
            dense
            toggle-color="primary"
            color="dark"
            text-color="grey-5"
            class="direction-toggle q-mb-sm"
          />
          <div class="row q-col-gutter-sm">
            <q-input
              v-model.number="form.maxBreakoutSeconds"
              type="number"
              label="Макс. время пробоя"
              suffix="сек"
              step="1"
              min="1"
              dense
              outlined
              dark
              class="col-6"
            />
            <q-input
              v-model.number="form.minMovePct"
              type="number"
              label="Мин. движение"
              suffix="%"
              step="0.1"
              min="0"
              dense
              outlined
              dark
              class="col-6"
            />
          </div>
        </div>
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps label="Отмена" color="grey-5" v-close-popup />
        <q-btn
          unelevated
          no-caps
          icon="play_arrow"
          label="Запустить анализ"
          color="primary"
          :loading="loading"
          :disable="!isValid"
          @click="onRun"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { reactive, computed, watch } from 'vue';
import type { AnalysisSettings } from 'src/stores/levels/analysis.store';
import type { ToleranceMode } from 'src/stores/levels/levels.store';
import { gapDuration } from 'src/stores/levels/timeframe';

const props = defineProps<{
  modelValue: boolean;
  settings: AnalysisSettings;
  timeframes: string[];
  loading: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  run: [settings: AnalysisSettings];
}>();

const DIRECTION_OPTIONS = [
  { label: 'Оба', value: 'both' },
  { label: 'Вверх', value: 'up' },
  { label: 'Вниз', value: 'down' },
];

const TOLERANCE_OPTIONS: { label: string; value: ToleranceMode }[] = [
  { label: 'NATR', value: 'natr' },
  { label: '%', value: 'pct' },
];

const MIN_CANDLES = 61;

// Local editable copy so closing without "Запустить" discards edits. Re-synced
// from props each time the dialog opens.
const form = reactive<AnalysisSettings>({ ...props.settings });

watch(
  () => props.modelValue,
  (open) => {
    if (open) Object.assign(form, props.settings);
  },
);

// The single "Погрешность" input edits natrMultiplier or tolerancePct depending
// on the active mode, so switching modes preserves both entries (mirrors LevelsFilters).
const tol = computed<number>({
  get: () => (form.toleranceMode === 'pct' ? form.tolerancePct : form.natrMultiplier),
  set: (v) => {
    if (form.toleranceMode === 'pct') form.tolerancePct = v;
    else form.natrMultiplier = v;
  },
});

// Wall-clock span of the "candles between touches" gap on the selected analysis
// timeframe, shown as a hint under the field (e.g. "≈ 1ч35м"). Empty while the
// timeframe/gap is unset so the hint just hides.
const gapHint = computed(() => {
  const duration = gapDuration(form.timeframe, form.minGap);
  return duration ? `≈ ${duration}` : '';
});

const isValid = computed(
  () =>
    !!form.timeframe &&
    (form.toleranceMode === 'pct'
      ? Number.isFinite(form.tolerancePct) && form.tolerancePct > 0
      : Number.isFinite(form.natrMultiplier) && form.natrMultiplier >= 0) &&
    Number.isFinite(form.minGap) &&
    form.minGap >= 1 &&
    Number.isFinite(form.maxBreakoutSeconds) &&
    form.maxBreakoutSeconds >= 1 &&
    Number.isFinite(form.minMovePct) &&
    form.minMovePct >= 0 &&
    Number.isFinite(form.candles) &&
    form.candles >= MIN_CANDLES,
);

function onRun() {
  if (!isValid.value) return;
  emit('run', { ...form });
  emit('update:modelValue', false);
}
</script>

<style lang="sass" scoped>
.analysis-dialog
  width: 480px
  max-width: 92vw
  border-color: $blue-dark

// Small uppercase caption above each field group.
.group-label
  font-size: 11px
  letter-spacing: 0.6px
  text-transform: uppercase
  color: $grey-6
  font-weight: 600
  margin-bottom: 6px

.direction-toggle
  border: 1px solid $blue-dark
  border-radius: 6px
  overflow: hidden

.tolerance-toggle
  border: 1px solid $blue-dark
  border-radius: 6px
  overflow: hidden
</style>

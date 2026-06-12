<template>
  <div class="row no-wrap items-center q-gutter-x-xs">
    <label class="filter-field row no-wrap items-center">
      <span class="filter-label text-grey-5">Объём&nbsp;≥</span>
      <input
        v-model.number="volM"
        type="number"
        :min="FLOOR_M"
        step="1"
        inputmode="decimal"
        class="filter-input"
        @keyup.enter="apply"
        @blur="apply"
      />
      <span class="filter-unit text-grey-6">M$</span>
      <q-tooltip>Минимальный оборот в USDT (млн): сумма volume·close по 24 свечам 1h. Минимум {{ FLOOR_M }} M$</q-tooltip>
    </label>

    <label class="filter-field row no-wrap items-center">
      <span class="filter-label text-grey-5">Погр.</span>
      <input
        v-model.number="tol"
        type="number"
        min="0"
        step="0.1"
        inputmode="decimal"
        class="filter-input"
        @keyup.enter="apply"
        @blur="apply"
      />
      <span class="filter-stepper column no-wrap items-center justify-center">
        <q-icon
          name="keyboard_arrow_up"
          size="14px"
          color="grey-6"
          class="filter-step"
          @click.prevent="stepTol(0.1)"
        />
        <q-icon
          name="keyboard_arrow_down"
          size="14px"
          color="grey-6"
          class="filter-step"
          @click.prevent="stepTol(-0.1)"
        />
      </span>
      <q-tooltip>{{ tolTooltip }}</q-tooltip>
    </label>

    <!-- Tolerance mode: NATR (band = natr · value) vs % (band = ±value% of price).
         Switching applies immediately so the screen recomputes with the new mode. -->
    <q-btn-toggle
      :model-value="mode"
      :options="TOLERANCE_OPTIONS"
      no-caps
      dense
      unelevated
      toggle-color="primary"
      color="dark"
      text-color="grey-5"
      class="tol-toggle"
      @update:model-value="onMode"
    >
      <q-tooltip>Единицы погрешности: NATR (адаптивно к волатильности) или % от цены (фиксировано)</q-tooltip>
    </q-btn-toggle>

    <label class="filter-field row no-wrap items-center">
      <span class="filter-label text-grey-5">{{ gapTime || 'Свечей' }}</span>
      <input
        v-model.number="gap"
        type="number"
        min="1"
        step="1"
        inputmode="numeric"
        class="filter-input"
        @keyup.enter="apply"
        @blur="apply"
      />
      <q-tooltip>
        Минимум свечей между касаниями уровня (ближе — считается одним касанием).
        Слева — это время на текущем ТФ ({{ gap }} × {{ props.timeframe || '—' }})
      </q-tooltip>
    </label>

    <q-btn
      no-caps
      dense
      unelevated
      icon="push_pin"
      class="filter-pin"
      :color="pinFavorites ? 'primary' : 'dark'"
      :text-color="pinFavorites ? 'white' : 'grey-5'"
      :disable="favoritesCount === 0 && !pinFavorites"
      @click="emit('toggle-pin')"
    >
      <q-tooltip>
        {{
          favoritesCount === 0 && !pinFavorites
            ? 'Нет избранных монет'
            : pinFavorites
              ? 'Открепить избранные'
              : 'Закрепить избранные сверху'
        }}
      </q-tooltip>
    </q-btn>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { LEVELS_MIN_VOLUME, type ToleranceMode } from 'src/stores/levels/levels.store';
import { gapDuration } from 'src/stores/levels/timeframe';

// Screener calculation params edited in the page header. The contract value for
// volume is raw USDT; the field edits millions for a compact input. Other params
// pass through as-is. Changes are committed on Enter/blur (one recompute, not per
// keystroke — the screener is computed on demand server-side).
const props = defineProps<{
  // Minimum USDT turnover (raw USDT); floored at LEVELS_MIN_VOLUME (20M).
  minVolume: number;
  // Which tolerance unit is active: 'natr' edits natrMultiplier, 'pct' edits tolerancePct.
  toleranceMode: ToleranceMode;
  natrMultiplier: number;
  tolerancePct: number;
  minGap: number;
  // Whether favorites are pinned to the top of the screener.
  pinFavorites: boolean;
  // Number of favorite coins — gates the pin button (can't pin with none).
  favoritesCount: number;
  // Current screener timeframe (e.g. '1m', '15m', '1h') — used to show the gap
  // (candles between touches) as an equivalent duration label.
  timeframe: string;
}>();

const emit = defineEmits<{
  (
    e: 'apply',
    value: {
      minVolume: number;
      toleranceMode: ToleranceMode;
      natrMultiplier: number;
      tolerancePct: number;
      minGap: number;
    },
  ): void;
  (e: 'toggle-pin'): void;
}>();

const TOLERANCE_OPTIONS: { label: string; value: ToleranceMode }[] = [
  { label: 'NATR', value: 'natr' },
  { label: '%', value: 'pct' },
];

const MILLION = 1_000_000;
// Smallest selectable volume, in millions (input unit). Mirrors the raw-USDT floor.
const FLOOR_M = LEVELS_MIN_VOLUME / MILLION;

const volM = ref<number>(props.minVolume / MILLION);
const mode = ref<ToleranceMode>(props.toleranceMode);
// Two independent tolerance values; the single visible input edits whichever the
// active mode selects (see `tol`), so switching modes preserves both entries.
const natr = ref<number>(props.natrMultiplier);
const pct = ref<number>(props.tolerancePct);
const gap = ref<number>(props.minGap);

// The visible tolerance input proxies to natr or pct depending on the mode.
const tol = computed<number>({
  get: () => (mode.value === 'pct' ? pct.value : natr.value),
  set: (v) => {
    if (mode.value === 'pct') pct.value = v;
    else natr.value = v;
  },
});

// Resync local inputs when the store changes the values elsewhere (e.g. reset).
watch(() => props.minVolume, (v) => (volM.value = v / MILLION));
watch(() => props.toleranceMode, (v) => (mode.value = v));
watch(() => props.natrMultiplier, (v) => (natr.value = v));
watch(() => props.tolerancePct, (v) => (pct.value = v));
watch(() => props.minGap, (v) => (gap.value = v));

function apply(): void {
  // Empty/invalid numeric inputs arrive as '' / NaN. Volume snaps up to the floor
  // (20M); tolerance and gap fall back to the current values rather than producing
  // a broken request.
  const minVolume = Math.max(LEVELS_MIN_VOLUME, Math.round((Number(volM.value) || 0) * MILLION));
  const natrMultiplier = Number(natr.value) > 0 ? Number(natr.value) : props.natrMultiplier;
  const tolerancePct = Number(pct.value) > 0 ? Number(pct.value) : props.tolerancePct;
  const minGap = Number(gap.value) >= 1 ? Math.round(Number(gap.value)) : props.minGap;
  // Reflect the normalized values back into the inputs (clears empty states).
  volM.value = minVolume / MILLION;
  natr.value = natrMultiplier;
  pct.value = tolerancePct;
  gap.value = minGap;
  emit('apply', { minVolume, toleranceMode: mode.value, natrMultiplier, tolerancePct, minGap });
}

// Switch the tolerance unit and recompute immediately (the band definition changes).
function onMode(next: ToleranceMode): void {
  if (next === mode.value) return;
  mode.value = next;
  apply();
}

// Step the active tolerance value by ±0.1 via the up/down arrows and commit
// immediately. Rounds to 1 decimal to avoid float drift (0.1+0.2 = 0.300…4) and
// floors at 0.1 — apply() treats 0 as invalid and would revert, so the smallest
// committed step is 0.1.
function stepTol(delta: number): void {
  const current = Number(tol.value) || 0;
  tol.value = Math.max(0.1, Math.round((current + delta) * 10) / 10);
  apply();
}

// Tooltip explaining the band built from the active mode.
const tolTooltip = computed(() =>
  mode.value === 'pct'
    ? 'Погрешность зоны касания в % от цены (ширина полосы = ±значение%). Стрелки — шаг 0.1'
    : 'Погрешность зоны касания в долях NATR (ширина полосы = natr · значение). Стрелки — шаг 0.1',
);

// Time the "candles between touches" gap spans on the current timeframe — shown
// in place of the "Свечей" label. Tracks the live input value; falls back to the
// committed minGap when the field is mid-edit/empty. Empty when the timeframe is
// unknown (label then reverts to "Свечей").
const gapTime = computed(() => {
  const candles = Number(gap.value) >= 1 ? Number(gap.value) : props.minGap;
  return gapDuration(props.timeframe, candles);
});
</script>

<style lang="sass" scoped>
// Filter "pills" matching the header control buttons (dark bg, 6px radius, same
// height) so the row reads as one cohesive control group rather than stray text.
.filter-field
  height: 32px
  padding: 0 10px
  background: $dark
  border-radius: 6px
  cursor: text
  transition: box-shadow 0.1s ease
  &:focus-within
    box-shadow: inset 0 0 0 1px $primary

.filter-label
  font-size: 12px
  white-space: nowrap
  user-select: none

.filter-input
  width: 48px
  margin: 0 6px 0 6px
  border: none
  outline: none
  background: transparent
  color: $title-color
  font-size: 13px
  font-weight: 600
  text-align: right
  // Drop native number spinners for a clean, flat look.
  -moz-appearance: textfield
  &::-webkit-outer-spin-button, &::-webkit-inner-spin-button
    -webkit-appearance: none
    margin: 0

.filter-unit
  font-size: 11px
  white-space: nowrap
  user-select: none

// Vertical ±0.1 stepper for the NATR field: two compact chevrons stacked inside
// the pill. Base grey (color="grey-6"); brighten on hover for affordance.
.filter-stepper
  margin-left: 4px
  height: 28px
  user-select: none

.filter-step
  cursor: pointer
  line-height: 1
  &:hover
    color: $title-color

// Tolerance unit toggle (NATR / %) — compact segmented control matching the
// 32px filter pills so it reads as part of the same control group.
.tol-toggle
  height: 32px
  border-radius: 6px
  overflow: hidden
  :deep(.q-btn)
    min-width: 34px
    font-size: 11px
    font-weight: 600

// Pin button aligned to the filter pills: same height and radius so the row
// stays one cohesive control group.
.filter-pin
  height: 32px
  min-width: 40px
  border-radius: 6px
</style>

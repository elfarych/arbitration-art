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
        v-model.number="natr"
        type="number"
        min="0"
        step="0.1"
        inputmode="decimal"
        class="filter-input"
        @keyup.enter="apply"
        @blur="apply"
      />
      <span class="filter-unit text-grey-6">NATR</span>
      <q-tooltip>Погрешность зоны касания в долях NATR (ширина полосы = natr · значение)</q-tooltip>
    </label>

    <label class="filter-field row no-wrap items-center">
      <span class="filter-label text-grey-5">Свечей</span>
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
      <q-tooltip>Минимум свечей между касаниями уровня (ближе — считается одним касанием)</q-tooltip>
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
import { ref, watch } from 'vue';
import { LEVELS_MIN_VOLUME } from 'src/stores/levels/levels.store';

// Screener calculation params edited in the page header. The contract value for
// volume is raw USDT; the field edits millions for a compact input. Other params
// pass through as-is. Changes are committed on Enter/blur (one recompute, not per
// keystroke — the screener is computed on demand server-side).
const props = defineProps<{
  // Minimum USDT turnover (raw USDT); floored at LEVELS_MIN_VOLUME (50M).
  minVolume: number;
  natrMultiplier: number;
  minGap: number;
  // Whether favorites are pinned to the top of the screener.
  pinFavorites: boolean;
  // Number of favorite coins — gates the pin button (can't pin with none).
  favoritesCount: number;
}>();

const emit = defineEmits<{
  (e: 'apply', value: { minVolume: number; natrMultiplier: number; minGap: number }): void;
  (e: 'toggle-pin'): void;
}>();

const MILLION = 1_000_000;
// Smallest selectable volume, in millions (input unit). Mirrors the raw-USDT floor.
const FLOOR_M = LEVELS_MIN_VOLUME / MILLION;

const volM = ref<number>(props.minVolume / MILLION);
const natr = ref<number>(props.natrMultiplier);
const gap = ref<number>(props.minGap);

// Resync local inputs when the store changes the values elsewhere (e.g. reset).
watch(() => props.minVolume, (v) => (volM.value = v / MILLION));
watch(() => props.natrMultiplier, (v) => (natr.value = v));
watch(() => props.minGap, (v) => (gap.value = v));

function apply(): void {
  // Empty/invalid numeric inputs arrive as '' / NaN. Volume snaps up to the floor
  // (50M); tolerance and gap fall back to the current values rather than producing
  // a broken request.
  const minVolume = Math.max(LEVELS_MIN_VOLUME, Math.round((Number(volM.value) || 0) * MILLION));
  const natrMultiplier = Number(natr.value) > 0 ? Number(natr.value) : props.natrMultiplier;
  const minGap = Number(gap.value) >= 1 ? Math.round(Number(gap.value)) : props.minGap;
  // Reflect the normalized values back into the inputs (clears empty states).
  volM.value = minVolume / MILLION;
  natr.value = natrMultiplier;
  gap.value = minGap;
  emit('apply', { minVolume, natrMultiplier, minGap });
}
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

// Pin button aligned to the filter pills: same height and radius so the row
// stays one cohesive control group.
.filter-pin
  height: 32px
  min-width: 40px
  border-radius: 6px
</style>

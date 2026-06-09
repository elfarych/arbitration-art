<template>
  <div class="ln-tab">
    <div class="ln-body">
      <!-- Master toggles -->
      <div class="ln-toggles">
        <div class="ln-toggle" :class="{ 'ln-toggle--on': form.enabled }">
          <div class="column">
            <span class="ln-toggle-label">Уведомления</span>
            <span class="ln-toggle-sub">включить алерты</span>
          </div>
          <q-toggle v-model="form.enabled" color="primary" dense />
        </div>
        <div class="ln-toggle" :class="{ 'ln-toggle--on': form.onlyFavorites }">
          <div class="column">
            <span class="ln-toggle-label">Избранные</span>
            <span class="ln-toggle-sub">только из списка</span>
          </div>
          <q-toggle v-model="form.onlyFavorites" color="primary" dense />
        </div>
      </div>

      <!-- Что сканируем -->
      <div class="ln-group">
        <div class="group-label">Что сканировать</div>
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
            v-model.number="form.minVolumeM"
            type="number"
            label="Объём ≥"
            suffix="M$"
            :min="FLOOR_M"
            step="1"
            dense
            outlined
            dark
            class="col-6"
            :hint="`минимум ${FLOOR_M} M$`"
          />
        </div>
      </div>

      <!-- Как ищем уровень -->
      <div class="ln-group">
        <div class="group-label">Поиск уровней</div>
        <div class="row q-col-gutter-sm">
          <q-input
            v-model.number="form.natrMultiplier"
            type="number"
            label="Погрешность"
            suffix="NATR"
            min="0"
            step="0.1"
            dense
            outlined
            dark
            class="col-6"
          />
          <q-input
            v-model.number="form.minGap"
            type="number"
            label="Свечей между касаниями"
            min="1"
            step="1"
            dense
            outlined
            dark
            class="col-6"
          />
        </div>
      </div>

      <!-- Когда уведомлять -->
      <div class="ln-group">
        <div class="group-label">Срабатывание</div>
        <q-btn-toggle
          v-model="form.distanceMode"
          :options="DISTANCE_OPTIONS"
          spread
          no-caps
          unelevated
          dense
          toggle-color="primary"
          color="transparent"
          text-color="grey-5"
          class="distance-toggle q-mb-sm"
        />
        <q-input
          v-model.number="form.distanceValue"
          type="number"
          label="Расстояние до уровня"
          :suffix="form.distanceMode === 'natr' ? 'NATR' : '%'"
          min="0"
          step="0.1"
          dense
          outlined
          dark
        />
      </div>

      <!-- Telegram (shared chat_id, owned by the dialog) -->
      <div class="ln-tg">
        <TelegramSettings
          :model-value="chatId"
          @update:model-value="(value) => emit('update:chatId', value)"
        />
      </div>

      <q-banner v-if="store.error" dense class="ln-error">
        {{ store.error }}
      </q-banner>
    </div>

    <div class="ln-actions">
      <q-btn flat no-caps label="Отмена" color="grey-5" v-close-popup />
      <q-btn
        unelevated
        no-caps
        icon="save"
        label="Сохранить"
        color="primary"
        class="ln-save"
        :loading="store.saving"
        :disable="!isValid"
        @click="onSave"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import { useLevelsStore, LEVELS_MIN_VOLUME } from 'src/stores/levels/levels.store';
import type { DistanceMode, NotificationConfig } from 'src/stores/levels/api/notificationsApi';
import TelegramSettings from './TelegramSettings.vue';

// `open` mirrors the dialog visibility: the local editable copy is re-synced from
// the store each time the dialog opens, so closing without "Сохранить" discards
// edits (the component stays mounted inside q-tab-panels). `chatId` is owned by the
// dialog (shared with the price tab) and saved together with the level fields here.
const props = defineProps<{ open: boolean; chatId: string }>();
const emit = defineEmits<{ saved: []; 'update:chatId': [value: string] }>();

const store = useNotificationsStore();
const levelsStore = useLevelsStore();
const { timeframes } = storeToRefs(levelsStore);

// Volume is stored as raw USDT but edited in millions for a compact input (same
// convention as LevelsFilters).
const MILLION = 1_000_000;
// Smallest selectable volume, in millions (input unit). Mirrors the raw-USDT floor.
const FLOOR_M = LEVELS_MIN_VOLUME / MILLION;

const DISTANCE_OPTIONS: { label: string; value: DistanceMode }[] = [
  { label: '%', value: 'pct' },
  { label: 'NATR', value: 'natr' },
];

interface FormState {
  enabled: boolean;
  onlyFavorites: boolean;
  timeframe: string;
  natrMultiplier: number;
  minGap: number;
  minVolumeM: number;
  distanceMode: DistanceMode;
  distanceValue: number;
}

const form = reactive<FormState>(toForm(store.config));

watch(
  () => props.open,
  (open) => {
    if (open) Object.assign(form, toForm(store.config));
  },
);

const isValid = computed(
  () =>
    !!form.timeframe &&
    Number.isFinite(form.natrMultiplier) &&
    form.natrMultiplier > 0 &&
    Number.isFinite(form.minGap) &&
    form.minGap >= 1 &&
    Number.isFinite(form.minVolumeM) &&
    form.minVolumeM >= FLOOR_M &&
    Number.isFinite(form.distanceValue) &&
    form.distanceValue > 0,
);

function toForm(config: NotificationConfig): FormState {
  return {
    enabled: config.enabled,
    onlyFavorites: config.onlyFavorites,
    timeframe: config.timeframe,
    natrMultiplier: config.natrMultiplier,
    minGap: config.minGap,
    minVolumeM: Math.max(FLOOR_M, config.minVolume / MILLION),
    distanceMode: config.distanceMode,
    distanceValue: config.distanceValue,
  };
}

async function onSave() {
  if (!isValid.value) return;
  try {
    await store.save({
      enabled: form.enabled,
      onlyFavorites: form.onlyFavorites,
      timeframe: form.timeframe,
      natrMultiplier: form.natrMultiplier,
      minGap: Math.round(form.minGap),
      minVolume: Math.max(LEVELS_MIN_VOLUME, Math.round(form.minVolumeM * MILLION)),
      distanceMode: form.distanceMode,
      distanceValue: form.distanceValue,
      chatId: props.chatId.trim(),
    });
    emit('saved');
  } catch {
    // Error is surfaced via store.error in the banner; keep the dialog open.
  }
}
</script>

<style lang="sass" scoped>
.ln-body
  display: flex
  flex-direction: column
  gap: 16px
  padding: 4px 18px 0
  max-height: 60vh
  overflow-y: auto

.group-label
  font-size: 11px
  letter-spacing: 0.6px
  text-transform: uppercase
  color: $grey-5
  font-weight: 700
  margin-bottom: 8px

// Master toggles
.ln-toggles
  display: grid
  grid-template-columns: 1fr 1fr
  gap: 10px

.ln-toggle
  display: flex
  align-items: center
  justify-content: space-between
  gap: 8px
  padding: 9px 12px
  border-radius: 11px
  border: 1px solid rgba(255, 255, 255, 0.07)
  background: rgba(255, 255, 255, 0.02)
  transition: border-color 0.15s ease, background 0.15s ease

.ln-toggle--on
  border-color: rgba($primary, 0.4)
  background: rgba($primary, 0.08)

.ln-toggle-label
  font-size: 13px
  font-weight: 600
  color: $title-color
  line-height: 1.1

.ln-toggle-sub
  font-size: 10.5px
  color: $grey-6
  margin-top: 2px

// Distance segmented toggle
.distance-toggle
  border: 1px solid rgba(255, 255, 255, 0.1)
  border-radius: 9px
  overflow: hidden
  background: rgba(0, 0, 0, 0.25)
  padding: 3px

  :deep(.q-btn)
    border-radius: 7px
    font-weight: 600

.ln-tg
  padding-top: 16px
  border-top: 1px solid rgba(255, 255, 255, 0.07)

.ln-error
  border-radius: 10px
  background: rgba($negative, 0.14)
  color: #ff8a94
  border: 1px solid rgba($negative, 0.3)

.ln-actions
  display: flex
  justify-content: flex-end
  gap: 8px
  padding: 14px 18px
  margin-top: 16px
  border-top: 1px solid rgba(255, 255, 255, 0.07)

.ln-save
  border-radius: 8px
  padding-left: 18px
  padding-right: 18px

// Unified input rounding across the form
:deep(.q-field--outlined .q-field__control)
  border-radius: 10px
</style>

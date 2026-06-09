<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="bg-dark text-white notifications-dialog" flat bordered>
      <q-card-section class="row items-center no-wrap q-py-sm">
        <q-icon name="notifications" size="22px" color="primary" class="q-mr-sm" />
        <span class="text-subtitle1 text-weight-bold">Уведомления по уровням</span>
        <q-space />
        <q-btn flat dense round icon="close" color="grey-5" v-close-popup />
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-section class="q-gutter-y-md">
        <div class="row items-center justify-between">
          <q-toggle v-model="form.enabled" label="Включить уведомления" color="primary" />
          <q-toggle v-model="form.onlyFavorites" label="Только избранные" color="primary" />
        </div>

        <!-- Что сканируем -->
        <div>
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
        <div>
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
        <div>
          <div class="group-label">Срабатывание</div>
          <q-btn-toggle
            v-model="form.distanceMode"
            :options="DISTANCE_OPTIONS"
            spread
            no-caps
            unelevated
            dense
            toggle-color="primary"
            color="dark"
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

        <!-- Telegram -->
        <div>
          <div class="group-label">Telegram</div>
          <div class="text-caption text-grey-5 q-mb-sm">
            Откройте бота, нажмите <span class="text-weight-medium">/start</span> — он пришлёт
            ваш <span class="text-weight-medium">chat_id</span>, вставьте его ниже.
          </div>
          <q-btn
            v-if="botUrl"
            :href="botUrl"
            target="_blank"
            rel="noopener noreferrer"
            type="a"
            icon="open_in_new"
            :label="botLabel"
            no-caps
            dense
            unelevated
            color="primary"
            size="sm"
            class="q-mb-sm"
          />
          <q-input
            v-model.trim="form.chatId"
            label="Chat ID"
            dense
            outlined
            dark
          />
        </div>

        <q-banner v-if="store.error" dense class="bg-negative text-white rounded-borders">
          {{ store.error }}
        </q-banner>
      </q-card-section>

      <q-separator color="blue-dark" />

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps label="Отмена" color="grey-5" v-close-popup />
        <q-btn
          unelevated
          no-caps
          icon="save"
          label="Сохранить"
          color="primary"
          :loading="store.saving"
          :disable="!isValid"
          @click="onSave"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { reactive, computed, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import { useLevelsStore, LEVELS_MIN_VOLUME } from 'src/stores/levels/levels.store';
import type { DistanceMode, NotificationConfig } from 'src/stores/levels/api/notificationsApi';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const store = useNotificationsStore();
const levelsStore = useLevelsStore();
const { timeframes } = storeToRefs(levelsStore);

// Telegram bot link — hardcoded to the notifications bot. Must stay the SAME bot
// whose token the level-notifier service uses (TELEGRAM_BOT_TOKEN), otherwise
// /start returns a chat_id that gets no alerts. Not read from env: process.env.*
// is not injected into the production bundle (see DOCS §28), so the env path left
// the button hidden in prod. botLabel (@username) is derived from the URL.
const botUrl = 'https://t.me/Brakeoutautobot';
const botMatch = botUrl.match(/t\.me\/([A-Za-z0-9_]+)/);
const botLabel = botMatch ? `@${botMatch[1]}` : 'Открыть бота';

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
  chatId: string;
}

// Local editable copy so closing without "Сохранить" discards edits. Re-synced
// from the store each time the dialog opens.
const form = reactive<FormState>(toForm(store.config));

watch(
  () => props.modelValue,
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
    chatId: config.chatId,
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
      chatId: form.chatId,
    });
    emit('update:modelValue', false);
  } catch {
    // Error is surfaced via store.error in the banner; keep the dialog open.
  }
}
</script>

<style lang="sass" scoped>
.notifications-dialog
  width: 460px
  max-width: 92vw
  border-color: $blue-dark

.group-label
  font-size: 11px
  letter-spacing: 0.6px
  text-transform: uppercase
  color: $grey-6
  font-weight: 600
  margin-bottom: 6px

.distance-toggle
  border: 1px solid $blue-dark
  border-radius: 6px
  overflow: hidden
</style>

<template>
  <div class="pn-tab">
    <div class="pn-body">
      <!-- Hint -->
      <div class="pn-hint">
        <q-icon name="ads_click" size="15px" class="pn-hint-icon" />
        <span>Правый клик по цене на графике создаёт уведомление. Срабатывает один раз.</span>
      </div>

      <q-banner v-if="store.error" dense class="pn-error">
        {{ store.error }}
      </q-banner>

      <!-- States -->
      <div v-if="store.loading && store.items.length === 0" class="pn-state">
        <q-spinner color="primary" size="26px" />
      </div>

      <div v-else-if="store.items.length === 0" class="pn-empty">
        <div class="pn-empty-icon">
          <q-icon name="notifications_none" size="24px" />
        </div>
        <div class="pn-empty-title">Пока нет ценовых уведомлений</div>
        <div class="pn-empty-sub">Правый клик по цене на графике, чтобы добавить</div>
      </div>

      <!-- Sections: Активные / Сработавшие -->
      <template v-else>
        <div v-for="section in sections" :key="section.key" class="pn-section">
          <div class="pn-section-head">
            <span class="pn-section-label">{{ section.label }}</span>
            <span class="pn-section-count">{{ section.items.length }}</span>
            <q-space />
            <q-btn
              v-if="section.key === 'fired'"
              flat
              dense
              no-caps
              size="11px"
              icon="delete_sweep"
              label="Очистить"
              color="grey-5"
              class="pn-clear"
              @click="onClearFired"
            />
          </div>

          <div class="pn-rows">
            <div
              v-for="item in section.items"
              :key="item.id"
              class="pn-row"
              :class="{ 'pn-row--fired': !item.enabled }"
            >
              <div class="pn-dir" :class="`pn-dir--${item.direction}`">
                <q-icon :name="item.direction === 'above' ? 'arrow_upward' : 'arrow_downward'" size="13px" />
                <q-tooltip>{{ item.direction === 'above' ? 'при росте до цены' : 'при падении до цены' }}</q-tooltip>
              </div>
              <span class="pn-symbol">{{ item.symbol }}</span>
              <span class="pn-price">{{ formatPrice(item.targetPrice) }}</span>
              <q-space />
              <span v-if="!item.enabled && item.triggeredAt" class="pn-time">
                {{ shortTime(item.triggeredAt) }}
                <q-tooltip>сработало {{ formatTime(item.triggeredAt) }}</q-tooltip>
              </span>
              <q-btn
                flat
                dense
                round
                size="sm"
                icon="close"
                class="pn-del"
                :loading="store.isPending(item.id)"
                @click="onRemove(item)"
              >
                <q-tooltip>Удалить</q-tooltip>
              </q-btn>
            </div>
          </div>
        </div>
      </template>

      <!-- Telegram -->
      <div class="pn-tg">
        <TelegramSettings
          :model-value="chatId"
          @update:model-value="(value) => emit('update:chatId', value)"
        />
        <q-banner v-if="notificationsStore.error" dense class="pn-error q-mt-sm">
          {{ notificationsStore.error }}
        </q-banner>
      </div>
    </div>

    <div class="pn-actions">
      <q-btn flat no-caps label="Закрыть" color="grey-5" v-close-popup />
      <q-btn
        unelevated
        no-caps
        icon="save"
        label="Сохранить"
        color="primary"
        class="pn-save"
        :loading="notificationsStore.saving"
        :disable="!notificationsStore.loaded"
        @click="onSaveChatId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { usePriceNotificationsStore } from 'src/stores/levels/priceNotifications.store';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import type { PriceNotification } from 'src/stores/levels/api/priceNotificationsApi';
import TelegramSettings from './TelegramSettings.vue';

// chat_id is the shared per-user value (owned by the dialog, also on the level
// tab). Saving here persists it without touching the level-detection fields.
const props = defineProps<{ chatId: string }>();
const emit = defineEmits<{ 'update:chatId': [value: string] }>();

const $q = useQuasar();
const store = usePriceNotificationsStore();
const notificationsStore = useNotificationsStore();

interface Section {
  key: 'active' | 'fired';
  label: string;
  items: PriceNotification[];
}

// Split into armed alerts and ones that have already fired (enabled=false).
const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  const active = store.items.filter((n) => n.enabled);
  const fired = store.items.filter((n) => !n.enabled);
  if (active.length) out.push({ key: 'active', label: 'Активные', items: active });
  if (fired.length) out.push({ key: 'fired', label: 'Сработавшие', items: fired });
  return out;
});

async function onSaveChatId() {
  const config = notificationsStore.config;
  try {
    await notificationsStore.save({
      enabled: config.enabled,
      onlyFavorites: config.onlyFavorites,
      timeframe: config.timeframe,
      natrMultiplier: config.natrMultiplier,
      minGap: config.minGap,
      minVolume: config.minVolume,
      distanceMode: config.distanceMode,
      distanceValue: config.distanceValue,
      chatId: props.chatId.trim(),
    });
  } catch {
    // Error is surfaced via notificationsStore.error in the banner.
  }
}

function onRemove(item: PriceNotification) {
  $q.dialog({
    title: 'Удалить уведомление',
    message: `${item.symbol} · ${formatPrice(item.targetPrice)}`,
    cancel: { label: 'Отмена', flat: true, noCaps: true, color: 'grey-5' },
    ok: { label: 'Удалить', unelevated: true, noCaps: true, color: 'negative' },
    persistent: true,
    dark: true,
    class: 'bg-dark text-white',
  }).onOk(() => {
    void store.remove(item.id);
  });
}

function onClearFired() {
  const count = store.items.filter((n) => !n.enabled).length;
  if (count === 0) return;
  $q.dialog({
    title: 'Удалить сработавшие',
    message: `Удалить все сработавшие уведомления (${count})?`,
    cancel: { label: 'Отмена', flat: true, noCaps: true, color: 'grey-5' },
    ok: { label: 'Удалить', unelevated: true, noCaps: true, color: 'negative' },
    persistent: true,
    dark: true,
    class: 'bg-dark text-white',
  }).onOk(() => {
    void store.removeFired();
  });
}

// Compact price formatting across the wide range of futures prices.
function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return String(value);
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

// Compact timestamp for the fired row (full datetime is in the tooltip).
function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
</script>

<style lang="sass" scoped>
.pn-body
  padding: 4px 18px 0
  max-height: 60vh
  overflow-y: auto

.pn-hint
  display: flex
  align-items: flex-start
  gap: 8px
  padding: 8px 11px
  border-radius: 9px
  background: rgba($primary, 0.08)
  border: 1px solid rgba($primary, 0.16)
  color: $grey-4
  font-size: 11.5px
  line-height: 1.4

.pn-hint-icon
  color: $primary
  margin-top: 1px
  flex: none

.pn-error
  margin-top: 10px
  border-radius: 10px
  background: rgba($negative, 0.14)
  color: #ff8a94
  border: 1px solid rgba($negative, 0.3)

.pn-state
  display: flex
  justify-content: center
  padding: 26px 0

// Empty state
.pn-empty
  display: flex
  flex-direction: column
  align-items: center
  text-align: center
  padding: 26px 0 22px

.pn-empty-icon
  display: flex
  align-items: center
  justify-content: center
  width: 48px
  height: 48px
  border-radius: 15px
  color: $grey-6
  background: rgba(255, 255, 255, 0.04)
  border: 1px solid rgba(255, 255, 255, 0.06)
  margin-bottom: 11px

.pn-empty-title
  font-size: 13px
  font-weight: 600
  color: $grey-4

.pn-empty-sub
  font-size: 11.5px
  color: $grey-6
  margin-top: 3px

// Sections
.pn-section
  margin-top: 14px

.pn-section-head
  display: flex
  align-items: center
  gap: 7px
  padding: 0 2px 7px

.pn-section-label
  font-size: 11px
  text-transform: uppercase
  letter-spacing: 0.5px
  font-weight: 700
  color: $grey-5

.pn-section-count
  display: inline-flex
  align-items: center
  justify-content: center
  min-width: 18px
  height: 16px
  padding: 0 5px
  border-radius: 20px
  font-size: 10.5px
  font-weight: 700
  color: $grey-6
  background: rgba(255, 255, 255, 0.07)

.pn-clear
  border-radius: 7px

  :deep(.q-icon)
    margin-right: 3px

// Rows (compact, single-line)
.pn-rows
  display: flex
  flex-direction: column
  gap: 5px

.pn-row
  display: flex
  align-items: center
  gap: 9px
  min-height: 38px
  padding: 5px 8px 5px 9px
  border-radius: 9px
  background: rgba(255, 255, 255, 0.025)
  border: 1px solid rgba(255, 255, 255, 0.06)
  transition: background 0.15s ease, border-color 0.15s ease

  &:hover
    background: rgba(255, 255, 255, 0.05)
    border-color: rgba(255, 255, 255, 0.1)

    .pn-del
      opacity: 1

.pn-row--fired
  opacity: 0.58

.pn-dir
  display: flex
  align-items: center
  justify-content: center
  width: 24px
  height: 24px
  border-radius: 7px
  flex: none

.pn-dir--above
  color: $positive
  background: rgba($positive, 0.14)

.pn-dir--below
  color: $negative
  background: rgba($negative, 0.14)

.pn-symbol
  font-size: 12.5px
  font-weight: 700
  color: $title-color
  letter-spacing: 0.2px

.pn-price
  font-size: 12.5px
  font-weight: 600
  color: #f5c542
  font-variant-numeric: tabular-nums

.pn-time
  font-size: 10.5px
  color: $grey-6
  white-space: nowrap
  font-variant-numeric: tabular-nums

.pn-del
  flex: none
  opacity: 0.5
  transition: opacity 0.15s ease, color 0.15s ease

  &:hover
    color: $negative

// Telegram block
.pn-tg
  margin-top: 16px
  padding-top: 16px
  border-top: 1px solid rgba(255, 255, 255, 0.07)

// Actions
.pn-actions
  display: flex
  justify-content: flex-end
  gap: 8px
  padding: 14px 18px
  margin-top: 4px
  border-top: 1px solid rgba(255, 255, 255, 0.07)

.pn-save
  border-radius: 8px
  padding-left: 18px
  padding-right: 18px
</style>

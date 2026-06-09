<template>
  <div class="pn-tab">
    <div class="pn-body">
      <!-- Hint -->
      <div class="pn-hint">
        <q-icon name="ads_click" size="17px" class="pn-hint-icon" />
        <span>
          Правый клик по цене на графике создаёт уведомление. Срабатывает один раз, затем
          отключается.
        </span>
      </div>

      <q-banner v-if="store.error" dense class="pn-error">
        {{ store.error }}
      </q-banner>

      <!-- List -->
      <div v-if="store.loading" class="pn-state">
        <q-spinner color="primary" size="28px" />
      </div>

      <div v-else-if="store.items.length === 0" class="pn-empty">
        <div class="pn-empty-icon">
          <q-icon name="notifications_none" size="26px" />
        </div>
        <div class="pn-empty-title">Пока нет ценовых уведомлений</div>
        <div class="pn-empty-sub">Правый клик по цене на графике, чтобы добавить</div>
      </div>

      <div v-else class="pn-rows">
        <div
          v-for="item in store.items"
          :key="item.id"
          class="pn-row"
          :class="{ 'pn-row--fired': !item.enabled }"
        >
          <div class="pn-dir" :class="`pn-dir--${item.direction}`">
            <q-icon :name="item.direction === 'above' ? 'arrow_upward' : 'arrow_downward'" size="15px" />
          </div>

          <div class="pn-info">
            <div class="pn-row-top">
              <span class="pn-symbol">{{ item.symbol }}</span>
              <span class="pn-price">{{ formatPrice(item.targetPrice) }}</span>
            </div>
            <div class="pn-meta">
              {{ item.direction === 'above' ? 'при росте до цены' : 'при падении до цены' }}
            </div>
          </div>

          <span v-if="!item.enabled" class="pn-fired-pill">
            <q-icon name="check" size="12px" />
            сработало
            <q-tooltip v-if="item.triggeredAt">{{ formatTime(item.triggeredAt) }}</q-tooltip>
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

// Compact price formatting across the wide range of futures prices.
function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return String(value);
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toFixed(digits).replace(/\.?0+$/, '');
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
  gap: 9px
  padding: 10px 12px
  border-radius: 10px
  background: rgba($primary, 0.08)
  border: 1px solid rgba($primary, 0.16)
  color: $grey-4
  font-size: 12px
  line-height: 1.45

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
  padding: 28px 0

// Empty state
.pn-empty
  display: flex
  flex-direction: column
  align-items: center
  text-align: center
  padding: 28px 0 24px

.pn-empty-icon
  display: flex
  align-items: center
  justify-content: center
  width: 52px
  height: 52px
  border-radius: 16px
  color: $grey-6
  background: rgba(255, 255, 255, 0.04)
  border: 1px solid rgba(255, 255, 255, 0.06)
  margin-bottom: 12px

.pn-empty-title
  font-size: 13px
  font-weight: 600
  color: $grey-4

.pn-empty-sub
  font-size: 11.5px
  color: $grey-6
  margin-top: 3px

// Rows
.pn-rows
  display: flex
  flex-direction: column
  gap: 8px
  margin-top: 12px

.pn-row
  display: flex
  align-items: center
  gap: 11px
  padding: 9px 11px
  border-radius: 11px
  background: rgba(255, 255, 255, 0.025)
  border: 1px solid rgba(255, 255, 255, 0.06)
  transition: background 0.15s ease, border-color 0.15s ease

  &:hover
    background: rgba(255, 255, 255, 0.05)
    border-color: rgba(255, 255, 255, 0.1)

    .pn-del
      opacity: 1

.pn-row--fired
  opacity: 0.62

.pn-dir
  display: flex
  align-items: center
  justify-content: center
  width: 30px
  height: 30px
  border-radius: 9px
  flex: none

.pn-dir--above
  color: $positive
  background: rgba($positive, 0.14)

.pn-dir--below
  color: $negative
  background: rgba($negative, 0.14)

.pn-info
  flex: 1 1 auto
  min-width: 0

.pn-row-top
  display: flex
  align-items: baseline
  gap: 8px

.pn-symbol
  font-size: 13px
  font-weight: 700
  color: $title-color
  letter-spacing: 0.2px

.pn-price
  font-size: 13px
  font-weight: 600
  color: #f5c542
  font-variant-numeric: tabular-nums

.pn-meta
  font-size: 11px
  color: $grey-6
  margin-top: 2px

.pn-fired-pill
  display: inline-flex
  align-items: center
  gap: 3px
  font-size: 10.5px
  font-weight: 600
  text-transform: uppercase
  letter-spacing: 0.3px
  color: $grey-5
  background: rgba(255, 255, 255, 0.06)
  border-radius: 20px
  padding: 3px 8px
  flex: none

.pn-del
  flex: none
  opacity: 0.55
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

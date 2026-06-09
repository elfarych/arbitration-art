<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    transition-show="jump-down"
    transition-hide="jump-up"
  >
    <q-card class="bg-dark text-white notifications-dialog" flat>
      <!-- Header -->
      <div class="dlg-header row items-center no-wrap">
        <div class="dlg-icon">
          <q-icon name="notifications" size="20px" />
        </div>
        <div class="column q-ml-sm">
          <span class="dlg-title">Уведомления</span>
          <span class="dlg-sub">Telegram-алерты по монетам</span>
        </div>
        <q-space />
        <q-btn flat dense round icon="close" size="sm" color="grey-5" v-close-popup>
          <q-tooltip>Закрыть</q-tooltip>
        </q-btn>
      </div>

      <!-- Segmented tabs -->
      <div class="dlg-tabs">
        <div class="seg" :class="`seg--${tab}`">
          <div class="seg-thumb"></div>
          <button
            type="button"
            class="seg-btn"
            :class="{ 'seg-btn--active': tab === 'prices' }"
            @click="tab = 'prices'"
          >
            <q-icon name="sell" size="15px" />
            <span>По цене</span>
          </button>
          <button
            type="button"
            class="seg-btn"
            :class="{ 'seg-btn--active': tab === 'levels' }"
            @click="tab = 'levels'"
          >
            <q-icon name="horizontal_rule" size="15px" />
            <span>По уровням</span>
          </button>
        </div>
      </div>

      <q-tab-panels v-model="tab" class="bg-transparent" animated keep-alive>
        <q-tab-panel name="prices" class="q-pa-none">
          <PriceNotificationsPanel v-model:chat-id="chatId" />
        </q-tab-panel>
        <q-tab-panel name="levels" class="q-pa-none">
          <LevelNotificationsForm
            :open="modelValue"
            v-model:chat-id="chatId"
            @saved="emit('update:modelValue', false)"
          />
        </q-tab-panel>
      </q-tab-panels>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import { usePriceNotificationsStore } from 'src/stores/levels/priceNotifications.store';
import LevelNotificationsForm from './LevelNotificationsForm.vue';
import PriceNotificationsPanel from './PriceNotificationsPanel.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const tab = ref<'prices' | 'levels'>('prices');

const notificationsStore = useNotificationsStore();
const priceNotificationsStore = usePriceNotificationsStore();

// Telegram chat_id is a single per-user value shared by both tabs. The dialog owns
// it (synced from the config when opened, discarded on close) and binds it into
// both tabs, so editing it on one tab and saving on the other cannot diverge.
const chatId = ref('');

// Load both feature stores when the dialog opens (idempotent), then sync the
// shared chat_id from the freshly-loaded config. The price list is also loaded by
// the screener page for the chart overlays, so that load is a no-op there.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    void priceNotificationsStore.load();
    await notificationsStore.load();
    chatId.value = notificationsStore.config.chatId;
  },
);
</script>

<style lang="sass" scoped>
.notifications-dialog
  width: 468px
  max-width: 94vw
  border-radius: 16px
  border: 1px solid rgba(255, 255, 255, 0.08)
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55)
  overflow: hidden

.dlg-header
  padding: 16px 18px 14px

.dlg-icon
  display: flex
  align-items: center
  justify-content: center
  width: 38px
  height: 38px
  border-radius: 11px
  color: $primary
  background: rgba($primary, 0.16)
  box-shadow: inset 0 0 0 1px rgba($primary, 0.25)

.dlg-title
  font-size: 16px
  font-weight: 700
  line-height: 1.15

.dlg-sub
  font-size: 11px
  color: $grey-6
  margin-top: 1px

.dlg-tabs
  padding: 0 18px 12px

.seg
  position: relative
  display: grid
  grid-template-columns: 1fr 1fr
  padding: 4px
  border-radius: 12px
  background: rgba(0, 0, 0, 0.3)
  border: 1px solid rgba(255, 255, 255, 0.05)

.seg-thumb
  position: absolute
  top: 4px
  bottom: 4px
  left: 4px
  width: calc(50% - 4px)
  border-radius: 9px
  background: rgba(255, 255, 255, 0.08)
  border: 1px solid rgba(255, 255, 255, 0.07)
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25)
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)

.seg--levels .seg-thumb
  transform: translateX(100%)

.seg-btn
  position: relative
  z-index: 1
  display: flex
  align-items: center
  justify-content: center
  gap: 6px
  padding: 9px 6px
  border: none
  background: transparent
  color: $grey-6
  font-family: inherit
  font-size: 13px
  font-weight: 600
  letter-spacing: 0.2px
  cursor: pointer
  transition: color 0.2s ease

  &:hover
    color: $grey-4

.seg-btn--active
  color: #fff

  &:hover
    color: #fff
</style>

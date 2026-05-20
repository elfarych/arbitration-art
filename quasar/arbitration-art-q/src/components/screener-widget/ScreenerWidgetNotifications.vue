<template>
  <div v-if="items.length > 0" class="widget-notifications">
    <q-card class="widget-notifications__panel bg-dark" flat>
      <div class="widget-notifications__header row items-center justify-between q-px-md q-py-sm">
        <div class="row items-center q-gutter-xs">
          <q-icon name="notifications" color="primary" size="xs" />
          <div class="text-caption text-grey-4">Новые в топе</div>
          <q-badge color="primary" text-color="white">{{ items.length }}</q-badge>
        </div>
        <q-btn
          flat
          dense
          no-caps
          size="sm"
          text-color="grey-4"
          label="Скрыть все"
          @click="$emit('dismiss-all')"
        />
      </div>

      <div class="widget-notifications__scroll">
        <transition-group name="widget-notif" tag="div" class="widget-notifications__stack q-pa-sm">
          <div
            v-for="item in items"
            :key="item.id"
            class="widget-notif-card row items-center no-wrap q-pa-sm"
          >
            <q-icon name="trending_up" color="primary" size="sm" class="q-mr-sm" />
            <div class="col">
              <div class="text-caption text-grey-5">
                Новая монета в топе ×{{ item.appearances }}
              </div>
              <div class="text-weight-bold text-title-color">
                {{ item.coin }}
                <span class="text-caption text-grey-5 q-ml-sm">позиция #{{ item.position }}</span>
              </div>
            </div>
            <q-btn
              flat
              dense
              round
              icon="content_copy"
              size="xs"
              text-color="grey-5"
              @click="onCopy(item.coin)"
            >
              <q-tooltip>Копировать тикер</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              icon="close"
              size="xs"
              text-color="grey-5"
              @click="$emit('dismiss', item.id)"
            />
          </div>
        </transition-group>
      </div>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { copyToClipboard, useQuasar } from 'quasar';
import type { WidgetNotification } from 'src/stores/screener/screenerWidget.store';

defineProps<{
  items: WidgetNotification[];
}>();

defineEmits<{
  (e: 'dismiss', id: number): void;
  (e: 'dismiss-all'): void;
}>();

const $q = useQuasar();

const onCopy = async (coin: string) => {
  try {
    await copyToClipboard(coin);
    $q.notify({
      message: `Скопировано: ${coin}`,
      color: 'primary',
      textColor: 'white',
      position: 'bottom',
      timeout: 1500,
    });
  } catch {
    $q.notify({
      message: 'Не удалось скопировать',
      color: 'negative',
      textColor: 'white',
      position: 'bottom',
      timeout: 1500,
    });
  }
};
</script>

<style lang="sass" scoped>
.widget-notifications
  position: fixed
  right: 24px
  bottom: 88px
  width: 340px
  max-width: calc(100vw - 48px)
  max-height: 70vh
  pointer-events: none
  display: flex
  flex-direction: column
  align-items: stretch

.widget-notifications__panel
  pointer-events: auto
  display: flex
  flex-direction: column
  border-radius: 12px
  border: 1px solid $blue-dark
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5)
  max-height: 70vh
  overflow: hidden

.widget-notifications__header
  border-bottom: 1px solid $blue-dark
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent)
  flex: 0 0 auto

.widget-notifications__scroll
  flex: 1 1 auto
  min-height: 0
  overflow-y: auto
  overflow-x: hidden
  // Custom thin scrollbar so the stack feels native inside the dark panel.
  scrollbar-width: thin
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent
  &::-webkit-scrollbar
    width: 6px
  &::-webkit-scrollbar-thumb
    background: rgba(255, 255, 255, 0.18)
    border-radius: 4px
  &::-webkit-scrollbar-track
    background: transparent

.widget-notifications__stack
  display: flex
  flex-direction: column
  gap: 8px

.widget-notif-card
  border-radius: 10px
  border: 1px solid $blue-dark
  background: rgba(255, 255, 255, 0.02)

.widget-notif-enter-active,
.widget-notif-leave-active
  transition: transform 0.25s ease, opacity 0.25s ease

.widget-notif-enter-from
  transform: translateX(40px)
  opacity: 0

.widget-notif-leave-to
  transform: translateX(40px)
  opacity: 0
</style>

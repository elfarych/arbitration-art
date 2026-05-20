<template>
  <div class="screener-widget">
    <ScreenerWidgetNotifications
      v-if="!store.expanded"
      :items="store.notifications"
      @dismiss="store.dismissNotification"
      @dismiss-all="store.dismissAllNotifications"
    />

    <transition name="widget-pop">
      <q-card v-if="store.expanded" class="widget-panel bg-dark" flat>
        <div class="row items-center justify-between q-px-md q-py-sm widget-panel__header">
          <div class="row items-center q-gutter-sm">
            <q-icon name="radar" color="primary" size="sm" />
            <div class="text-subtitle2 text-weight-bold text-title-color">Топ-скринер</div>
            <q-badge v-if="store.loading" color="primary" class="q-ml-sm">обновление…</q-badge>
          </div>
          <div class="row items-center q-gutter-xs">
            <q-btn
              v-if="store.isConfigured && !showSettings"
              flat
              dense
              round
              icon="settings"
              size="sm"
              text-color="grey-5"
              @click="showSettings = true"
            >
              <q-tooltip>Настройки</q-tooltip>
            </q-btn>
            <q-btn
              v-if="store.isConfigured && !showSettings"
              flat
              dense
              round
              icon="refresh"
              size="sm"
              text-color="grey-5"
              :loading="store.loading"
              @click="store.scanOnce()"
            >
              <q-tooltip>Обновить сейчас</q-tooltip>
            </q-btn>
            <q-btn flat dense round icon="close" size="sm" text-color="grey-5" @click="store.toggleExpanded()">
              <q-tooltip>Свернуть</q-tooltip>
            </q-btn>
          </div>
        </div>

        <q-separator dark />

        <ScreenerWidgetSettings
          v-if="!store.isConfigured || showSettings"
          :initial="store.settings"
          :allow-cancel="store.isConfigured"
          @save="onSettingsSave"
          @cancel="showSettings = false"
        />

        <ScreenerWidgetTopList v-else :rows="store.results" :error="store.error" />
      </q-card>
    </transition>

    <q-btn
      class="widget-toggle"
      :class="{ 'widget-toggle--expanded': store.expanded }"
      round
      unelevated
      :color="store.expanded ? 'grey-9' : 'primary'"
      :text-color="store.expanded ? 'grey-5' : 'white'"
      :icon="store.expanded ? 'close' : 'radar'"
      size="md"
      @click="store.toggleExpanded()"
    >
      <q-tooltip v-if="!store.expanded">Топ-скринер</q-tooltip>
      <q-badge
        v-if="!store.expanded && store.notifications.length > 0"
        floating
        color="negative"
        text-color="white"
        rounded
      >
        {{ store.notifications.length }}
      </q-badge>
    </q-btn>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useScreenerWidgetStore, type WidgetSettings } from 'src/stores/screener/screenerWidget.store';
import ScreenerWidgetSettings from './ScreenerWidgetSettings.vue';
import ScreenerWidgetTopList from './ScreenerWidgetTopList.vue';
import ScreenerWidgetNotifications from './ScreenerWidgetNotifications.vue';

const store = useScreenerWidgetStore();
const showSettings = ref(false);

const onSettingsSave = (next: WidgetSettings) => {
  store.saveSettings(next);
  showSettings.value = false;
};

onMounted(() => {
  store.init();
});

onBeforeUnmount(() => {
  store.stopPolling();
});
</script>

<style lang="sass" scoped>
.screener-widget
  position: fixed
  right: 24px
  bottom: 24px
  z-index: 4000
  display: flex
  flex-direction: column
  align-items: flex-end
  pointer-events: none

  > *
    pointer-events: auto

.widget-toggle
  margin-top: 12px
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45)

.widget-toggle--expanded
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45)

.widget-panel
  width: 380px
  max-width: calc(100vw - 48px)
  max-height: calc(100vh - 140px)
  border-radius: 14px
  overflow: hidden
  border: 1px solid $blue-dark
  display: flex
  flex-direction: column
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5)

.widget-panel__header
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent)

.widget-pop-enter-active,
.widget-pop-leave-active
  transition: transform 0.18s ease, opacity 0.18s ease

.widget-pop-enter-from,
.widget-pop-leave-to
  transform: translateY(8px) scale(0.98)
  opacity: 0
</style>

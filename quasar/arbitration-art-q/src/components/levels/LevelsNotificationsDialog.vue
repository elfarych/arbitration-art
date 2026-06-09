<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="bg-dark text-white notifications-dialog" flat bordered>
      <q-card-section class="row items-center no-wrap q-py-sm">
        <q-icon name="notifications" size="22px" color="primary" class="q-mr-sm" />
        <span class="text-subtitle1 text-weight-bold">Уведомления</span>
        <q-space />
        <q-btn flat dense round icon="close" color="grey-5" v-close-popup />
      </q-card-section>

      <q-tabs
        v-model="tab"
        dense
        no-caps
        active-color="primary"
        indicator-color="primary"
        align="left"
        class="text-grey-5 bg-dark"
      >
        <q-tab name="levels" label="По уровням" />
        <q-tab name="prices" label="По цене" />
      </q-tabs>

      <q-separator color="blue-dark" />

      <q-tab-panels v-model="tab" class="bg-dark" animated keep-alive>
        <q-tab-panel name="levels" class="q-pa-none">
          <LevelNotificationsForm :open="modelValue" @saved="emit('update:modelValue', false)" />
        </q-tab-panel>
        <q-tab-panel name="prices" class="q-pa-none">
          <PriceNotificationsPanel />
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

const tab = ref<'levels' | 'prices'>('levels');

const notificationsStore = useNotificationsStore();
const priceNotificationsStore = usePriceNotificationsStore();

// Load both feature stores when the dialog opens (idempotent). The price list is
// also loaded by the screener page for the chart overlays, so this is a no-op
// there; it covers opening the dialog from contexts that didn't preload it.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    void notificationsStore.load();
    void priceNotificationsStore.load();
  },
);
</script>

<style lang="sass" scoped>
.notifications-dialog
  width: 460px
  max-width: 92vw
  border-color: $blue-dark
</style>

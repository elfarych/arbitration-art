<template>
  <div>
    <q-card-section class="q-gutter-y-sm">
      <!-- Telegram hint: price alerts reuse the chat_id from the level tab. -->
      <q-banner
        v-if="!hasChatId"
        dense
        class="bg-blue-dark text-grey-4 rounded-borders text-caption"
      >
        Укажите Telegram <span class="text-weight-medium">chat_id</span> во вкладке
        «По уровням» — иначе ценовые алерты не придут.
      </q-banner>

      <div class="text-caption text-grey-5">
        Создавайте уведомления правым кликом по цене на графике скринера. Срабатывает
        один раз, затем отключается.
      </div>

      <q-banner v-if="store.error" dense class="bg-negative text-white rounded-borders">
        {{ store.error }}
      </q-banner>
    </q-card-section>

    <q-separator color="blue-dark" />

    <q-card-section class="notifications-list q-pa-none">
      <div v-if="store.loading" class="row justify-center q-pa-md">
        <q-spinner color="primary" size="md" />
      </div>
      <div
        v-else-if="store.items.length === 0"
        class="text-center text-grey-6 text-caption q-pa-lg"
      >
        Пока нет ценовых уведомлений
      </div>
      <q-list v-else separator dark>
        <q-item v-for="item in store.items" :key="item.id" dense>
          <q-item-section avatar>
            <q-icon
              :name="item.direction === 'above' ? 'north' : 'south'"
              :color="item.direction === 'above' ? 'positive' : 'negative'"
              size="20px"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-weight-medium">
              {{ item.symbol }}
              <span class="text-grey-4">{{ formatPrice(item.targetPrice) }}</span>
            </q-item-label>
            <q-item-label caption class="text-grey-6">
              <span v-if="item.triggeredAt && !item.enabled">
                сработал {{ formatTime(item.triggeredAt) }}
              </span>
              <span v-else>{{ item.direction === 'above' ? 'при росте до цены' : 'при падении до цены' }}</span>
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="delete_outline"
              color="grey-5"
              :loading="store.isPending(item.id)"
              @click="onRemove(item)"
            >
              <q-tooltip>Удалить</q-tooltip>
            </q-btn>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card-section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { usePriceNotificationsStore } from 'src/stores/levels/priceNotifications.store';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import type { PriceNotification } from 'src/stores/levels/api/priceNotificationsApi';

const $q = useQuasar();
const store = usePriceNotificationsStore();
const notificationsStore = useNotificationsStore();

// chat_id is shared with the level-notification config; warn if it is missing.
const hasChatId = computed(() => notificationsStore.config.chatId.trim().length > 0);

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
.notifications-list
  max-height: 320px
  overflow-y: auto
</style>

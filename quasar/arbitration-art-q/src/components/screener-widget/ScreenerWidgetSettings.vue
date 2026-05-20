<template>
  <q-form class="widget-settings q-pa-md q-gutter-sm" @submit.prevent="onSubmit">
    <div class="text-caption text-grey-5">
      Виджет показывает топ монет по спреду между двумя биржами и считает, сколько раз каждая монета появлялась в топе.
    </div>

    <q-select
      v-model="form.primaryExchange"
      :options="exchangeOptions"
      label="Биржа основная"
      dark
      outlined
      dense
      emit-value
      map-options
      options-dense
    />

    <q-select
      v-model="form.secondaryExchange"
      :options="exchangeOptions"
      label="Биржа вторая"
      dark
      outlined
      dense
      emit-value
      map-options
      options-dense
      :rules="[(v) => v !== form.primaryExchange || 'Биржи должны отличаться']"
    />

    <q-select
      v-model="form.orderType"
      :options="orderOptions"
      label="Тип сделки"
      dark
      outlined
      dense
      emit-value
      map-options
      options-dense
    />

    <q-input
      v-model.number="form.minVolume"
      type="number"
      label="Мин. объём 24ч (USDT)"
      hint="0 — без фильтра"
      dark
      outlined
      dense
      min="0"
    />

    <q-input
      v-model.number="form.topCount"
      type="number"
      label="Кол-во топовых монет"
      dark
      outlined
      dense
      :min="1"
      :max="50"
      :rules="[(v) => (v >= 1 && v <= 50) || '1–50']"
    />

    <q-toggle
      v-model="form.notifyOnNew"
      label="Уведомлять о новых монетах в топе"
      color="primary"
      dark
    />

    <div class="row q-gutter-sm justify-end q-mt-sm">
      <q-btn v-if="allowCancel" flat no-caps label="Отмена" color="grey-5" @click="$emit('cancel')" />
      <q-btn type="submit" no-caps unelevated color="primary" text-color="white" label="Сохранить" />
    </div>
  </q-form>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { WidgetSettings } from 'src/stores/screener/screenerWidget.store';

const props = defineProps<{
  initial: WidgetSettings | null;
  allowCancel: boolean;
}>();

const emit = defineEmits<{
  (e: 'save', value: WidgetSettings): void;
  (e: 'cancel'): void;
}>();

const defaults = (): WidgetSettings => ({
  primaryExchange: 'binance_futures',
  secondaryExchange: 'bybit_futures',
  orderType: 'buy',
  minVolume: 0,
  topCount: 10,
  notifyOnNew: true,
});

const form = reactive<WidgetSettings>({ ...(props.initial ?? defaults()) });

watch(
  () => props.initial,
  (next) => {
    Object.assign(form, next ?? defaults());
  },
);

const exchangeOptions = [
  { label: 'Binance Futures', value: 'binance_futures' },
  { label: 'MEXC Futures', value: 'mexc_futures' },
  { label: 'Bybit Futures', value: 'bybit_futures' },
  { label: 'Binance Spot', value: 'binance_spot' },
];

const orderOptions = [
  { label: 'Покупка (Лонг)', value: 'buy' },
  { label: 'Продажа (Шорт)', value: 'sell' },
];

const onSubmit = () => {
  if (form.primaryExchange === form.secondaryExchange) return;
  if (!(form.topCount >= 1 && form.topCount <= 50)) return;
  emit('save', {
    primaryExchange: form.primaryExchange,
    secondaryExchange: form.secondaryExchange,
    orderType: form.orderType,
    minVolume: Math.max(0, Number(form.minVolume) || 0),
    topCount: Math.round(form.topCount),
    notifyOnNew: !!form.notifyOnNew,
  });
};
</script>

<style lang="sass" scoped>
.widget-settings
  overflow-y: auto
</style>

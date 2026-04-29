<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" persistent>
    <q-card dark class="runtime-dialog bg-dark text-text-color">
      <q-card-section class="dialog-header">
        <div>
          <div class="text-h6 text-title-color">{{ isEdit ? 'Редактировать runtime' : 'Новый runtime' }}</div>
          <div class="text-caption text-grey-5">Standalone arbitration-trader</div>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-separator dark />

      <q-card-section class="dialog-body">
        <q-form class="runtime-form" @submit.prevent="submit">
          <section class="form-section">
            <div class="section-title">Основное</div>
            <div class="form-grid two-columns">
              <q-input v-model.trim="form.name" label="Название" outlined dense dark :rules="[requiredRule]" />
              <q-input v-model.trim="form.service_url" label="Trader service URL" outlined dense dark :rules="[requiredRule]" />
            </div>
          </section>

          <section class="form-section">
            <div class="section-title">Биржи</div>
            <div class="form-grid two-columns">
              <q-select
                v-model="form.primary_exchange"
                :options="exchangeOptions"
                label="Основная биржа"
                outlined
                dense
                dark
                emit-value
                map-options
                :rules="[requiredRule, distinctExchangeRule]"
              />
              <q-select
                v-model="form.secondary_exchange"
                :options="exchangeOptions"
                label="Вторая биржа"
                outlined
                dense
                dark
                emit-value
                map-options
                :rules="[requiredRule, distinctExchangeRule]"
              />
              <q-toggle v-model="form.use_testnet" label="Testnet" color="positive" dark />
            </div>
          </section>

          <section class="form-section">
            <div class="section-title">Торговые лимиты</div>
            <div class="form-grid four-columns">
              <q-input v-model.number="form.trade_amount_usdt" type="number" min="0" step="0.01" label="Сумма сделки USDT" outlined dense dark :rules="[positiveRule]" />
              <q-input v-model.number="form.leverage" type="number" min="1" step="1" label="Плечо" outlined dense dark :rules="[positiveRule]" />
              <q-input v-model.number="form.max_concurrent_trades" type="number" min="1" step="1" label="Сделок одновременно" outlined dense dark :rules="[positiveRule]" />
              <q-input v-model.number="form.top_liquid_pairs_count" type="number" min="1" step="1" label="Top 24h movers" outlined dense dark :rules="[positiveRule]" />
            </div>
          </section>

          <section class="form-section">
            <div class="section-title">Сигналы и риск</div>
            <div class="form-grid four-columns">
              <q-input v-model.number="form.open_threshold" type="number" step="0.0001" label="Порог входа %" outlined dense dark :rules="[numberRule]" />
              <q-input v-model.number="form.close_threshold" type="number" step="0.0001" label="Порог выхода %" outlined dense dark :rules="[numberRule]" />
              <q-input v-model.number="form.max_trade_duration_minutes" type="number" min="1" step="1" label="Таймаут, мин" outlined dense dark :rules="[positiveRule]" />
              <q-input v-model.number="form.max_leg_drawdown_percent" type="number" min="0" step="0.01" label="Просадка плеча %" outlined dense dark :rules="[positiveRule]" />
            </div>
          </section>

          <section class="form-section">
            <div class="section-title">Runtime</div>
            <div class="form-grid runtime-grid" :class="{ 'with-toggle': isEdit }">
              <q-input v-model.number="form.orderbook_limit" type="number" min="1" step="1" label="Orderbook limit" outlined dense dark :rules="[positiveRule]" />
              <q-input v-model.number="form.chunk_size" type="number" min="1" step="1" label="Chunk size" outlined dense dark :rules="[positiveRule]" />
              <div v-if="isEdit" class="toggle-cell">
                <q-toggle v-model="form.is_active" label="Активен" color="positive" dark :disable="runtimeConfig?.is_deleted" />
              </div>
            </div>
          </section>

          <q-card-actions align="right" class="dialog-actions">
            <q-btn flat no-caps label="Отмена" color="grey-4" v-close-popup />
            <q-btn type="submit" no-caps label="Сохранить" color="primary" :loading="saving" />
          </q-card-actions>
        </q-form>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useTraderRuntimeStore } from 'src/stores/trader-runtime/traderRuntime.store';
import type {
  TraderExchange,
  TraderRuntimeConfig,
  TraderRuntimeConfigPayload,
} from 'src/stores/trader-runtime/api/traderRuntimeConfig';

const props = defineProps<{
  modelValue: boolean;
  runtimeConfig: TraderRuntimeConfig | null;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'saved', value: TraderRuntimeConfig): void;
}>();

const $q = useQuasar();
const store = useTraderRuntimeStore();

const isEdit = computed(() => props.runtimeConfig !== null);
const saving = computed(() => store.saving);

const exchangeOptions: { label: string; value: TraderExchange }[] = [
  { label: 'Binance', value: 'binance' },
  { label: 'Bybit', value: 'bybit' },
  { label: 'Gate', value: 'gate' },
  { label: 'MEXC', value: 'mexc' },
];

const defaultForm: TraderRuntimeConfigPayload = {
  name: '',
  service_url: 'http://127.0.0.1:3002',
  primary_exchange: 'binance',
  secondary_exchange: 'bybit',
  use_testnet: true,
  trade_amount_usdt: 10,
  leverage: 3,
  max_concurrent_trades: 1,
  top_liquid_pairs_count: 100,
  max_trade_duration_minutes: 60,
  max_leg_drawdown_percent: 80,
  open_threshold: 0.2,
  close_threshold: 0,
  orderbook_limit: 50,
  chunk_size: 10,
  is_active: false,
};

const form = ref<TraderRuntimeConfigPayload>({ ...defaultForm });

const requiredRule = (value: unknown) => Boolean(value) || 'Обязательное поле';
const numberRule = (value: unknown) => Number.isFinite(Number(value)) || 'Укажите число';
const positiveRule = (value: unknown) => Number(value) > 0 || 'Значение должно быть больше 0';
const distinctExchangeRule = () => form.value.primary_exchange !== form.value.secondary_exchange || 'Биржи должны отличаться';

function configToPayload(config: TraderRuntimeConfig): TraderRuntimeConfigPayload {
  return {
    name: config.name,
    service_url: config.service_url,
    primary_exchange: config.primary_exchange,
    secondary_exchange: config.secondary_exchange,
    use_testnet: config.use_testnet,
    trade_amount_usdt: Number(config.trade_amount_usdt),
    leverage: config.leverage,
    max_concurrent_trades: config.max_concurrent_trades,
    top_liquid_pairs_count: config.top_liquid_pairs_count,
    max_trade_duration_minutes: config.max_trade_duration_minutes,
    max_leg_drawdown_percent: Number(config.max_leg_drawdown_percent),
    open_threshold: Number(config.open_threshold),
    close_threshold: Number(config.close_threshold),
    orderbook_limit: config.orderbook_limit,
    chunk_size: config.chunk_size,
    is_active: config.is_active,
  };
}

async function submit() {
  try {
    const saved = props.runtimeConfig
      ? await store.updateConfig(props.runtimeConfig.id, form.value)
      : await store.createConfig({ ...form.value, is_active: false });

    $q.notify({ color: 'positive', message: 'Runtime config сохранен' });
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (error) {
    console.error(error);
    $q.notify({ color: 'negative', message: 'Не удалось сохранить runtime config' });
  }
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) {
      return;
    }

    form.value = props.runtimeConfig
      ? configToPayload(props.runtimeConfig)
      : { ...defaultForm };
  },
);
</script>

<style lang="sass" scoped>
.runtime-dialog
  width: 820px
  max-width: 94vw
  border: 1px solid $blue-dark
  border-radius: $generic-border-radius

.dialog-header
  display: flex
  align-items: center
  padding: 18px 20px 14px

.dialog-body
  padding: 18px 20px 20px

.runtime-form
  display: flex
  flex-direction: column
  gap: 14px

.form-section
  padding: 14px
  border: 1px solid rgba(255, 255, 255, 0.08)
  border-radius: $generic-border-radius
  background: rgba(255, 255, 255, 0.025)

.section-title
  margin-bottom: 12px
  color: $title-color
  font-size: 12px
  font-weight: 700
  text-transform: uppercase
  letter-spacing: 0

.form-grid
  display: grid
  gap: 14px

.two-columns
  grid-template-columns: repeat(2, minmax(0, 1fr))

.four-columns
  grid-template-columns: repeat(4, minmax(0, 1fr))

.runtime-grid
  grid-template-columns: repeat(2, minmax(0, 1fr))

.runtime-grid.with-toggle
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(140px, 0.7fr)

.toggle-cell
  min-height: 40px
  display: flex
  align-items: center

.dialog-actions
  padding: 4px 0 0
  gap: 8px

.text-title-color
  color: $title-color !important

.text-text-color
  color: $text-color !important

@media (max-width: 760px)
  .dialog-header
    padding: 16px

  .dialog-body
    padding: 16px

  .two-columns,
  .four-columns,
  .runtime-grid,
  .runtime-grid.with-toggle
    grid-template-columns: 1fr
</style>

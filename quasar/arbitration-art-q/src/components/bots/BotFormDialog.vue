<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" persistent transition-show="scale" transition-hide="scale">
    <q-card style="width: 500px; max-width: 90vw;" class="bg-dark text-text-color">
      <q-card-section class="dialog-header border-bottom-dark">
        <div class="text-h6 text-title-color text-weight-bold">{{ isEdit ? 'Редактировать бота' : 'Новый бот' }}</div>
        <q-btn icon="close" flat round dense v-close-popup color="grey-5" />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <q-form @submit.prevent="onSubmit" class="bot-form">
          
          <div class="grid-cols-2">
            <div>
              <q-select 
                v-model="form.primary_exchange" 
                :options="exchangeOptions" 
                label="Биржа основная" 
                outlined dense dark emit-value map-options
                :rules="[val => !!val || 'Обязательное поле']"
              />
            </div>
            <div>
              <q-select 
                v-model="form.secondary_exchange" 
                :options="exchangeOptions" 
                label="Биржа вторая" 
                outlined dense dark emit-value map-options
                :rules="[val => !!val || 'Обязательное поле']"
              />
            </div>
          </div>

          <!-- Валидация монеты -->
          <div class="grid-cols-coin">
            <div>
              <q-input 
                v-model="form.coin" 
                label="Монета (напр. BTC)" 
                outlined dense dark
                :rules="[val => !!val || 'Укажите монету']"
              />
            </div>
            <div>
              <q-btn 
                color="info" text-color="white" no-caps
                label="Проверить" 
                class="full-width q-mt-xs"
                :loading="validating"
                :disable="!form.coin || !form.primary_exchange || !form.secondary_exchange"
                @click="validateCoin"
              />
            </div>
          </div>

          <div v-if="validationResults.length > 0" class="validation-box q-pa-sm bg-surface border-radius-sm">
            <div v-for="(v, i) in validationResults" :key="i" class="validation-item q-mb-xs">
              <q-icon :name="v.exists ? 'check_circle' : 'cancel'" :color="v.exists ? 'positive' : 'negative'" class="q-mr-sm" size="xs" />
              <span class="text-caption">{{ exchangeLabels[v.exchange] }}: <span class="text-weight-bold">{{ form.coin }}</span></span>
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input v-model.number="form.entry_spread" type="number" step="0.001" label="Спред входа (%)" outlined dense dark :rules="[val => val !== null || 'Обязательно']" />
            </div>
            <div>
               <q-input v-model.number="form.exit_spread" type="number" step="0.001" label="Спред выхода (%)" outlined dense dark :rules="[val => val !== null || 'Обязательно']" />
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input v-model.number="form.coin_amount" type="number" step="0.001" label="Кол-во монет (шт)" outlined dense dark :rules="[val => !!val || 'Обязательно']" @update:model-value="updateEstimated" autocomplete="off" />
              <div v-if="estimatedUsdt > 0" class="text-caption text-positive q-mt-xs text-right">≈ {{ estimatedUsdt.toFixed(2) }} USDT margin</div>
            </div>
            <div>
              <q-input v-model.number="form.max_trades" type="number" label="Максимальное кол-во сделок" outlined dense dark />
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input v-model.number="form.primary_leverage" type="number" :label="`Плечо ${exchangeLabels[form.primary_exchange] || '(осн)'}`" outlined dense dark />
            </div>
             <div>
              <q-input v-model.number="form.secondary_leverage" type="number" :label="`Плечо ${exchangeLabels[form.secondary_exchange] || '(вт)'}`" outlined dense dark />
            </div>
          </div>

          <div class="grid-cols-2 q-mt-sm">
            <div>
              <q-toggle v-model="form.trade_on_primary_exchange" :label="`Открывать сделки на ${exchangeLabels[form.primary_exchange] || ''}`" color="positive" dark dense />
            </div>
            <div>
              <q-toggle v-model="form.trade_on_secondary_exchange" :label="`Открывать сделки на ${exchangeLabels[form.secondary_exchange] || ''}`" color="positive" dark dense />
            </div>
          </div>

          <div class="grid-cols-2 q-mt-sm">
            <div>
              <div class="text-caption opacity-70 q-mb-xs">Режим работы</div>
              <q-btn-toggle
                v-model="form.trade_mode"
                spread
                no-caps
                toggle-color="primary"
                color="dark"
                text-color="grey"
                toggle-text-color="dark"
                :disable="isEdit"
                :options="[
                  {label: 'Эмулятор', value: 'emulator'},
                  {label: 'Торговля', value: 'real'}
                ]"
              />
            </div>
            <div>
              <div class="text-caption opacity-70 q-mb-xs">Направление</div>
              <q-btn-toggle
                v-model="form.order_type"
                spread
                no-caps
                toggle-color="primary"
                color="dark"
                text-color="grey"
                toggle-text-color="dark"
                :options="[
                  {label: 'Покупка', value: 'buy'},
                  {label: 'Продажа', value: 'sell'}
                ]"
              />
            </div>
          </div>

          <q-toggle v-if="isEdit" v-model="form.is_active" label="Активен" color="primary" dark class="q-mt-md" />

          <div class="dialog-actions border-top-dark">
            <q-btn flat no-caps label="Отмена" v-close-popup color="grey-3" />
            <q-btn type="submit" no-caps :loading="saving" color="primary" text-color="white" label="Сохранить" :disable="!isCoinValid" />
          </div>

        </q-form>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { BotConfig, BotConfigPayload } from 'src/stores/bots/api/botConfig';
import { useBotsStore } from 'src/stores/bots/bots.store';
import { useExchangesStore } from 'src/stores/exchanges/exchanges.store';
import { useQuasar } from 'quasar';

const props = defineProps<{
  modelValue: boolean;
  bot: BotConfig | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved'): void;
}>();

const $q = useQuasar();
const botsStore = useBotsStore();
const exchangesStore = useExchangesStore();

const isEdit = computed(() => !!props.bot);

const exchangeOptions = [
  { label: 'Binance Futures', value: 'binance_futures' },
  { label: 'Binance Spot', value: 'binance_spot' },
  { label: 'Bybit Futures', value: 'bybit_futures' },
  { label: 'Mexc Futures', value: 'mexc_futures' }
];

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance Futures',
  binance_spot: 'Binance Spot',
  bybit_futures: 'Bybit Futures',
  mexc_futures: 'Mexc Futures'
};

const defaultForm: BotConfigPayload = {
  primary_exchange: 'binance_futures',
  secondary_exchange: 'mexc_futures',
  coin: '',
  coin_amount: 0,
  entry_spread: 0,
  exit_spread: 0,
  max_trades: 1,
  primary_leverage: 10,
  secondary_leverage: 10,
  order_type: 'buy',
  trade_mode: 'emulator',
  trade_on_primary_exchange: true,
  trade_on_secondary_exchange: true,
  is_active: true
};

const form = ref<BotConfigPayload>({ ...defaultForm });

const validating = ref(false);
const validationResults = ref<{exchange: string, exists: boolean}[]>([]);
const isCoinValid = computed(() => {
  // If not validated via button yet, assume true if edit, false if not?
  // User should press Validate. Or we can just allow it if we are editing.
  if (isEdit.value && validationResults.value.length === 0) return true;
  return validationResults.value.length === 2 && validationResults.value.every(v => v.exists);
});

const estimatedUsdt = ref(0);
let priceCache = 0;

const validateCoin = async () => {
  if (!form.value.coin) return;
  validating.value = true;
  validationResults.value = [];
  
  try {
    const res = await exchangesStore.validateSymbol(form.value.coin, form.value.primary_exchange, form.value.secondary_exchange);

    validationResults.value = [
      { exchange: form.value.primary_exchange, exists: res.primaryExists },
      { exchange: form.value.secondary_exchange, exists: res.secondaryExists }
    ];

    if (res.primaryExists && res.price) {
      priceCache = res.price;
      updateEstimated();
    }
  } catch (e) {
    console.error(e);
  } finally {
    validating.value = false;
  }
};

const updateEstimated = () => {
  if (priceCache && form.value.coin_amount) {
    estimatedUsdt.value = priceCache * form.value.coin_amount;
  } else {
    estimatedUsdt.value = 0;
  }
};

const saving = ref(false);

const onSubmit = async () => {
  saving.value = true;
  try {
    if (isEdit.value && props.bot) {
      await botsStore.updateBot(props.bot.id, form.value);
      $q.notify({ color: 'positive', message: 'Бот успешно обновлен!' });
    } else {
      form.value.coin = form.value.coin.toUpperCase();
      await botsStore.createBot(form.value);
      $q.notify({ color: 'positive', message: 'Бот успешно создан!' });
    }
    emit('saved');
    emit('update:modelValue', false);
  } catch (e) {
    $q.notify({ color: 'negative', message: 'Ошибка при сохранении' });
  } finally {
    saving.value = false;
  }
};

// Sync form on open
watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    validationResults.value = [];
    estimatedUsdt.value = 0;
    priceCache = 0;
    
    if (props.bot) {
      form.value = { ...props.bot };
    } else {
      form.value = { ...defaultForm };
    }
  }
});
</script>

<style lang="sass" scoped>
.bot-form
  display: grid
  gap: 16px

.dialog-header
  display: flex
  align-items: center
  justify-content: space-between

.grid-cols-2
  display: grid
  grid-template-columns: 1fr 1fr
  gap: 16px

.grid-cols-coin
  display: grid
  grid-template-columns: 2fr 1fr
  gap: 16px
  align-items: start

.dialog-actions
  display: flex
  justify-content: flex-end
  gap: 8px
  margin-top: 24px
  padding-top: 8px

.validation-item
  display: flex
  align-items: center

.border-bottom-dark
  border-bottom: 1px solid $blue-dark
.border-top-dark
  border-top: 1px solid $blue-dark
.bg-surface
  background-color: rgba(255, 255, 255, 0.03)
.border-radius-sm
  border-radius: $generic-border-radius
.opacity-70
  opacity: 0.7
</style>

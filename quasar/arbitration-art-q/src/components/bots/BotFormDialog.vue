<template>
  <q-dialog :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" persistent transition-show="scale" transition-hide="scale">
    <q-card style="width: 500px; max-width: 90vw;" class="bg-dark text-text-color">
      <q-card-section class="dialog-header border-bottom-dark">
        <div class="text-h6 text-title-color text-weight-bold">{{ isEdit ? 'Редактировать бота' : 'Новый бот' }}</div>
        <q-btn icon="close" flat round dense v-close-popup color="grey-5" />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <q-banner v-if="restrictedNotice" dense rounded class="bg-warning text-dark q-mb-md text-caption">
          <q-icon name="warning" class="q-mr-xs" />
          {{ restrictedNotice }}
        </q-banner>

        <q-banner v-if="missingKeysNotice" dense rounded class="bg-negative text-white q-mb-md text-caption">
          <q-icon name="error" class="q-mr-xs" />
          {{ missingKeysNotice }}
        </q-banner>

        <q-form @submit.prevent="onSubmit" class="bot-form">

          <div class="grid-cols-2">
            <div>
              <q-select
                v-model="form.primary_exchange"
                :options="exchangeOptions"
                label="Биржа основная"
                outlined dense dark emit-value map-options
                :disable="lockRestrictedFields"
                :rules="[val => !!val || 'Обязательное поле']"
              />
            </div>
            <div>
              <q-select
                v-model="form.secondary_exchange"
                :options="exchangeOptions"
                label="Биржа вторая"
                outlined dense dark emit-value map-options
                :disable="lockRestrictedFields"
                :rules="[val => !!val || 'Обязательное поле', val => val !== form.primary_exchange || 'Биржа должна отличаться от основной']"
              />
            </div>
          </div>

          <!-- Coin (ccxt format: BTC/USDT:USDT) -->
          <div class="grid-cols-coin">
            <div>
              <q-input
                v-model="coinBase"
                label="Монета (напр. BTC)"
                outlined dense dark
                :disable="isEdit"
                hint="Будет преобразовано в формат BTC/USDT:USDT"
                :rules="[val => !!val || 'Укажите монету', val => /^[A-Z0-9]{1,15}$/.test((val || '').toString().toUpperCase()) || 'Только латиница и цифры, до 15 символов']"
                @update:model-value="onCoinInput"
              />
            </div>
            <div>
              <q-btn
                color="info" text-color="white" no-caps
                label="Проверить"
                class="full-width q-mt-xs"
                :loading="validating"
                :disable="!coinBase || !form.primary_exchange || !form.secondary_exchange"
                @click="validateCoin"
              />
            </div>
          </div>

          <div v-if="validationResults.length > 0" class="validation-box q-pa-sm bg-surface border-radius-sm">
            <div v-for="(v, i) in validationResults" :key="i" class="validation-item q-mb-xs">
              <q-icon :name="v.exists ? 'check_circle' : 'cancel'" :color="v.exists ? 'positive' : 'negative'" class="q-mr-sm" size="xs" />
              <span class="text-caption">{{ exchangeLabels[v.exchange] }}: <span class="text-weight-bold">{{ coinBase }}</span></span>
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input v-model.number="form.entry_spread" type="number" step="0.001" label="Спред входа (%)" outlined dense dark :rules="[val => val !== null && val !== '' || 'Обязательно']" />
            </div>
            <div>
               <q-input v-model.number="form.exit_spread" type="number" step="0.001" label="Спред выхода (%)" outlined dense dark :rules="[val => val !== null && val !== '' || 'Обязательно']" />
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input
                v-model.number="form.coin_amount"
                type="number" step="0.00000001" min="0"
                label="Кол-во монет (шт)"
                outlined dense dark
                :rules="[val => (val !== null && val > 0) || 'Должно быть больше 0']"
                @update:model-value="updateEstimated"
                autocomplete="off"
              />
              <div v-if="estimatedUsdt > 0" class="text-caption text-positive q-mt-xs text-right">≈ {{ estimatedUsdt.toFixed(2) }} USDT margin</div>
            </div>
            <div>
              <q-input v-model.number="form.max_trades" type="number" label="Максимальное кол-во сделок" outlined dense dark />
            </div>
          </div>

          <div class="grid-cols-2">
            <div>
              <q-input
                v-model.number="form.primary_leverage"
                type="number"
                :label="`Плечо ${exchangeLabels[form.primary_exchange] || '(осн)'}`"
                outlined dense dark
                :disable="lockRestrictedFields"
              />
            </div>
             <div>
              <q-input
                v-model.number="form.secondary_leverage"
                type="number"
                :label="`Плечо ${exchangeLabels[form.secondary_exchange] || '(вт)'}`"
                outlined dense dark
                :disable="lockRestrictedFields"
              />
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
              <div class="text-caption opacity-70 q-mb-xs">
                Режим работы
                <span v-if="isEdit" class="opacity-50">(нельзя менять после создания)</span>
              </div>
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

          <q-separator dark class="q-my-md opacity-30" />
          <div class="text-caption opacity-70 q-mb-sm text-weight-bold">Предохранители / Safety</div>
          <div class="grid-cols-2">
            <div>
              <q-input v-model.number="form.max_trade_duration_seconds" type="number" min="10" step="1" label="Таймаут (сек)" outlined dense dark />
            </div>
            <div>
              <q-input v-model.number="form.max_leg_drawdown_percent" type="number" step="0.1" label="Просадка ликвидации (%)" outlined dense dark />
            </div>
            <div>
              <q-input
                v-model.number="form.min_trade_interval_seconds"
                type="number"
                min="0"
                step="1"
                label="Интервал между сделками (сек)"
                hint="После закрытия следующая сделка не откроется раньше этого срока"
                outlined
                dense
                dark
              />
            </div>
          </div>

          <q-toggle v-if="isEdit" v-model="form.is_active" label="Активен" color="primary" dark class="q-mt-md" />

          <div v-if="serverError" class="text-negative q-mt-md text-caption">
            <q-icon name="error_outline" class="q-mr-xs" /> {{ serverError }}
          </div>

          <div class="dialog-actions border-top-dark">
            <q-btn flat no-caps label="Отмена" v-close-popup color="grey-3" />
            <q-btn type="submit" no-caps :loading="saving" color="primary" text-color="white" label="Сохранить" :disable="!canSubmit" />
          </div>

        </q-form>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import type { BotConfig, BotConfigPayload } from 'src/stores/bots/api/botConfig';
import { useBotsStore } from 'src/stores/bots/bots.store';
import { useExchangesStore } from 'src/stores/exchanges/exchanges.store';
import { useProfileStore } from 'src/stores/profile/profile.store';
import { storeToRefs } from 'pinia';
import { useQuasar } from 'quasar';
import { extractApiErrorMessage } from 'src/utils/apiError';

// Bot exchange choice ("binance_futures") -> UserExchangeKeys prefix
// ("binance"). Must stay in sync with Django _EXCHANGE_KEY_PREFIX and
// Engine.extractKeys; mismatched mapping would break the pre-flight check.
const EXCHANGE_KEY_PREFIX: Record<string, 'binance' | 'bybit' | 'gate' | 'mexc'> = {
  binance_futures: 'binance',
  bybit_futures: 'bybit',
  gate_futures: 'gate',
  mexc_futures: 'mexc',
};

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
const profileStore = useProfileStore();
const { exchangeKeys } = storeToRefs(profileStore);

const isEdit = computed(() => !!props.bot);

// Lock infrastructure-level fields while the bot is active. Django serializer
// rejects in-place mutations to these fields when is_active=true; mirroring the
// rule in the UI prevents 400 errors and gives the operator a clear instruction.
const lockRestrictedFields = computed(() =>
  isEdit.value && !!props.bot?.is_active && form.value.is_active !== false,
);

const restrictedNotice = computed(() => {
  if (!lockRestrictedFields.value) return '';
  return 'Остановите бота (Активен = выкл), чтобы менять биржу, режим или плечо. После сохранения активируйте снова.';
});

// Django BOT_EXCHANGE_CHOICES — engine has no spot client, so spot is not a
// valid choice here.
const exchangeOptions = [
  { label: 'Binance Futures', value: 'binance_futures' },
  { label: 'Bybit Futures', value: 'bybit_futures' },
  { label: 'Gate Futures', value: 'gate_futures' },
  { label: 'Mexc Futures', value: 'mexc_futures' },
];

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance Futures',
  bybit_futures: 'Bybit Futures',
  gate_futures: 'Gate Futures',
  mexc_futures: 'Mexc Futures',
};

const defaultForm: BotConfigPayload = {
  primary_exchange: 'binance_futures',
  secondary_exchange: 'bybit_futures',
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
  max_trade_duration_seconds: 3600,
  max_leg_drawdown_percent: 80.0,
  min_trade_interval_seconds: 10,
  is_active: true,
};

const form = ref<BotConfigPayload>({ ...defaultForm });
// Coin is edited as a bare ticker ("BTC") and serialised to ccxt format
// ("BTC/USDT:USDT") on submit to match Django's validate_coin regex.
const coinBase = ref('');

function ccxtSymbol(base: string): string {
  return `${base.trim().toUpperCase()}/USDT:USDT`;
}

function baseFromCcxt(value: string): string {
  const match = /^([A-Z0-9]{1,15})\/USDT:USDT$/i.exec(value || '');
  return match?.[1]?.toUpperCase() ?? '';
}

const onCoinInput = (val: string | number | null) => {
  const raw = (val ?? '').toString().toUpperCase();
  coinBase.value = raw;
  validationResults.value = [];
};

const validating = ref(false);
const validationResults = ref<{ exchange: string; exists: boolean }[]>([]);
const serverError = ref('');

const isCoinValidated = computed(() => {
  // Edits without re-running the validator can submit because Django will
  // re-validate on the server side; for new bots we require the validation
  // step so the operator notices typos early.
  if (isEdit.value && validationResults.value.length === 0) return true;
  return validationResults.value.length === 2 && validationResults.value.every(v => v.exists);
});

// Pre-flight check: real mode requires API keys for every leg that will
// execute. Engine.extractKeys throws if keys are missing, Django mirrors the
// check at serializer level — the UI surfaces the same message before the
// user even submits so they know exactly where to go fix it.
const missingKeyLegs = computed<string[]>(() => {
  if (form.value.trade_mode !== 'real') return [];
  if (!form.value.is_active) return [];
  const missing: string[] = [];
  const check = (exchange: string, enabled: boolean | undefined) => {
    if (!enabled) return;
    const prefix = EXCHANGE_KEY_PREFIX[exchange];
    if (!prefix) return;
    const state = exchangeKeys.value[prefix];
    if (!state || !state.has_api_key || !state.has_secret) {
      missing.push(exchangeLabels[exchange] ?? exchange);
    }
  };
  check(form.value.primary_exchange, form.value.trade_on_primary_exchange);
  check(form.value.secondary_exchange, form.value.trade_on_secondary_exchange);
  return missing;
});

const missingKeysNotice = computed(() => {
  if (missingKeyLegs.value.length === 0) return '';
  const list = missingKeyLegs.value.join(', ');
  return `Нет API-ключей для биржи: ${list}. Откройте Профиль → API-ключи и добавьте ключи перед активацией реальной торговли.`;
});

const canSubmit = computed(() => {
  if (!coinBase.value) return false;
  if (form.value.primary_exchange === form.value.secondary_exchange) return false;
  if (missingKeyLegs.value.length > 0) return false;
  return isCoinValidated.value;
});

const estimatedUsdt = ref(0);
let priceCache = 0;

const validateCoin = async () => {
  if (!coinBase.value) return;
  validating.value = true;
  validationResults.value = [];

  try {
    const res = await exchangesStore.validateSymbol(coinBase.value, form.value.primary_exchange, form.value.secondary_exchange);
    validationResults.value = [
      { exchange: form.value.primary_exchange, exists: res.primaryExists },
      { exchange: form.value.secondary_exchange, exists: res.secondaryExists },
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
  const amount = Number(form.value.coin_amount);
  if (priceCache && amount) {
    estimatedUsdt.value = priceCache * amount;
  } else {
    estimatedUsdt.value = 0;
  }
};

const saving = ref(false);

const onSubmit = async () => {
  saving.value = true;
  serverError.value = '';
  try {
    const payload: BotConfigPayload = {
      ...form.value,
      coin: ccxtSymbol(coinBase.value),
    };
    if (isEdit.value && props.bot) {
      await botsStore.updateBot(props.bot.id, payload);
      $q.notify({ color: 'positive', message: 'Бот успешно обновлен!' });
    } else {
      await botsStore.createBot(payload);
      $q.notify({ color: 'positive', message: 'Бот успешно создан!' });
    }
    emit('saved');
    emit('update:modelValue', false);
  } catch (e) {
    const message = extractApiErrorMessage(e, 'Ошибка при сохранении');
    serverError.value = message;
    $q.notify({ color: 'negative', message });
  } finally {
    saving.value = false;
  }
};

// Mounted once per dialog instance. The store may already be populated by
// ProfilePage; calling fetch again is cheap and guarantees the pre-flight key
// check uses up-to-date state if the user added keys in another tab.
onMounted(() => {
  void profileStore.fetchExchangeKeys();
});

// Sync form on open
watch(() => props.modelValue, (isOpen) => {
  if (!isOpen) return;
  // Refresh keys each time the dialog opens so a user who just added keys in
  // another tab does not see a stale "missing keys" warning.
  void profileStore.fetchExchangeKeys();
  validationResults.value = [];
  estimatedUsdt.value = 0;
  priceCache = 0;
  serverError.value = '';

  if (props.bot) {
    form.value = {
      primary_exchange: props.bot.primary_exchange,
      secondary_exchange: props.bot.secondary_exchange,
      entry_spread: props.bot.entry_spread,
      exit_spread: props.bot.exit_spread,
      coin: props.bot.coin,
      coin_amount: props.bot.coin_amount,
      order_type: props.bot.order_type,
      trade_mode: props.bot.trade_mode,
      max_trades: props.bot.max_trades,
      primary_leverage: props.bot.primary_leverage,
      secondary_leverage: props.bot.secondary_leverage,
      trade_on_primary_exchange: props.bot.trade_on_primary_exchange,
      trade_on_secondary_exchange: props.bot.trade_on_secondary_exchange,
      max_trade_duration_seconds: props.bot.max_trade_duration_seconds,
      max_leg_drawdown_percent: props.bot.max_leg_drawdown_percent,
      min_trade_interval_seconds: props.bot.min_trade_interval_seconds ?? 10,
      is_active: props.bot.is_active,
    };
    coinBase.value = baseFromCcxt(props.bot.coin) || props.bot.coin.toUpperCase();
  } else {
    form.value = { ...defaultForm };
    coinBase.value = '';
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

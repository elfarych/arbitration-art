<template>
  <q-card flat bordered class="bot-card bg-dark text-text-color line-height-normal" :class="!bot.is_active ? 'inactive-card' : ''">
    <!-- Header -->
    <q-card-section class="row items-center justify-between q-pb-none">
      <div class="row items-center">
        <q-badge color="primary" text-color="dark" class="q-mr-sm text-weight-bold">{{ bot.coin }}</q-badge>
        <span class="text-subtitle2 text-weight-medium text-title-color">
          {{ formatExchange(bot.primary_exchange) }} <span class="opacity-50">→</span> {{ formatExchange(bot.secondary_exchange) }}
        </span>
      </div>
      <div class="status-dot" :class="{ 'active-dot': bot.is_active }"></div>
    </q-card-section>

    <q-card-section>
      <!-- Spread Data -->
      <div v-if="spreadStats?.loading" class="skeleton-wrapper">
        <div class="row justify-between q-mb-xs">
          <div>
            <q-skeleton type="rect" width="70px" height="16px" class="bg-grey-9 q-mb-xs" />
            <q-skeleton type="rect" width="110px" height="12px" class="bg-grey-9" />
          </div>
          <div>
            <q-skeleton type="rect" width="70px" height="16px" class="bg-grey-9 q-mb-xs q-ml-auto" />
            <q-skeleton type="rect" width="110px" height="12px" class="bg-grey-9 q-ml-auto" />
          </div>
        </div>
        
        <q-skeleton type="rect" width="100%" height="120px" class="q-my-sm border-radius-sm bg-grey-9" />

        <q-skeleton type="rect" width="100%" height="124px" class="q-mt-sm border-radius-sm bg-grey-9" />
      </div>
      <div v-else-if="spreadStats?.current">
        <div class="row justify-between text-caption q-mb-xs">
          <div>
            <div class="text-weight-bold"><span class="text-positive opacity-70">O:</span> {{ spreadStats.current.openSpread.toFixed(3) }}</div>
            <div style="font-size: 10px" class="opacity-50">min: {{ spreadStats.minOpen.toFixed(3) }} max: {{ spreadStats.maxOpen.toFixed(3) }}</div>
          </div>
          <div class="text-right">
            <div class="text-weight-bold"><span class="text-negative opacity-70">C:</span> {{ spreadStats.current.closeSpread.toFixed(3) }}</div>
            <div style="font-size: 10px" class="opacity-50">min: {{ spreadStats.minClose.toFixed(3) }} max: {{ spreadStats.maxClose.toFixed(3) }}</div>
          </div>
        </div>
        
        <SpreadChart :history="spreadStats.history" class="q-my-sm" />

        <!-- Info Table -->
        <div class="exchange-info bg-surface q-pa-sm q-mt-sm border-radius-sm text-caption">
          <div class="row text-weight-bold opacity-50 q-mb-xs">
            <div class="col-4"></div>
            <div class="col-4 text-center">{{ formatExchange(bot.primary_exchange) }}</div>
            <div class="col-4 text-center">{{ formatExchange(bot.secondary_exchange) }}</div>
          </div>
          
          <div class="row q-mb-xs">
            <div class="col-4 opacity-70">Ask</div>
            <div class="col-4 text-center">{{ spreadStats.primaryAsk.toFixed(5) }}</div>
            <div class="col-4 text-center">{{ spreadStats.secondaryAsk.toFixed(5) }}</div>
          </div>
          <div class="row q-mb-xs">
            <div class="col-4 opacity-70">Bid</div>
            <div class="col-4 text-center">{{ spreadStats.primaryBid.toFixed(5) }}</div>
            <div class="col-4 text-center">{{ spreadStats.secondaryBid.toFixed(5) }}</div>
          </div>

          <q-separator dark class="q-my-sm opacity-30" />
          
          <template v-if="info?.primary && info?.secondary">
            <div class="row q-mb-xs">
              <div class="col-4 opacity-70">Funding</div>
              <div class="col-4 text-center" :class="info.primary.fundingRate > 0 ? 'text-positive' : 'text-negative'">
                {{ info.primary.fundingRate.toFixed(4) }}%
              </div>
              <div class="col-4 text-center" :class="info.secondary.fundingRate > 0 ? 'text-positive' : 'text-negative'">
                {{ info.secondary.fundingRate.toFixed(4) }}%
              </div>
            </div>

            <div class="row">
              <div class="col-4 opacity-70">Next</div>
              <div class="col-4 text-center opacity-70">{{ nextFundingTimePrimary }}</div>
              <div class="col-4 text-center opacity-70">{{ nextFundingTimeSecondary }}</div>
            </div>
          </template>
          <template v-else>
            <div class="row q-mb-xs">
              <div class="col-4 opacity-70">Funding</div>
              <div class="col-4 flex justify-center"><q-skeleton type="text" width="40px" class="bg-grey-9" /></div>
              <div class="col-4 flex justify-center"><q-skeleton type="text" width="40px" class="bg-grey-9" /></div>
            </div>
            <div class="row">
              <div class="col-4 opacity-70">Next</div>
              <div class="col-4 flex justify-center"><q-skeleton type="text" width="50px" class="bg-grey-9" /></div>
              <div class="col-4 flex justify-center"><q-skeleton type="text" width="50px" class="bg-grey-9" /></div>
            </div>
          </template>
        </div>
      </div>
    </q-card-section>

    <!-- Bot Config Stats -->
    <q-card-section class="q-pt-none text-caption q-mt-sm">
      <div class="row q-col-gutter-sm text-center q-mb-md">
        <div class="col-6">
          <div class="text-weight-bold opacity-50">Open spread</div>
          <div class="text-positive text-weight-medium text-subtitle2">{{ bot.entry_spread }}%</div>
        </div>
        <div class="col-6">
          <div class="text-weight-bold opacity-50">Close spread</div>
          <div class="text-negative text-weight-medium text-subtitle2">{{ bot.exit_spread }}%</div>
        </div>
      </div>

      <div class="q-mb-md">
        <q-input 
          v-model="displayAmount" 
          type="text" 
          dense 
          outlined 
          dark 
          label="Количество"
          @focus="onFocusAmount"
          @blur="onBlurAmount"
          @update:model-value="amountInputChanged"
        >
          <template v-slot:append>
            <span class="text-caption opacity-50" style="font-size: 12px">
              <span v-if="spreadStats?.primaryAsk">~{{ formatUsdt(localAmount * spreadStats.primaryAsk) }} USDT</span>
              <q-spinner v-else size="12px" />
            </span>
          </template>
        </q-input>
      </div>

      <div class="row items-center justify-between">
        <div class="text-weight-bold opacity-50">Тип ордера</div>
        <div class="text-uppercase text-weight-medium">{{ bot.order_type }}</div>
      </div>
    </q-card-section>

    <!-- Actions -->
    <q-card-actions align="right" class="border-top-dark q-pt-sm q-pb-sm">
      <q-btn flat round dense :icon="bot.is_active ? 'pause' : 'play_arrow'" :color="bot.is_active ? 'warning' : 'positive'" @click="emit('toggle', bot)" />
      <q-btn flat round dense icon="show_chart" color="info" @click="emit('history', bot)" />
      <q-btn flat round dense icon="edit" color="primary" @click="emit('edit', bot)" />
      <q-btn flat round dense icon="delete" color="negative" @click="emit('delete', bot.id)" />
    </q-card-actions>
  </q-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { botConfigApi, type BotConfig } from 'src/services/api/botConfig';
import { useSpreadMonitor, type SpreadStats } from 'src/composables/useSpreadMonitor';
import { exchangeInfoService, type BotExchangeInfo } from 'src/services/exchanges/exchangeInfo';
import SpreadChart from './SpreadChart.vue';
import { useQuasar } from 'quasar';

const props = defineProps<{ bot: BotConfig }>();
const emit = defineEmits<{
  (e: 'toggle', bot: BotConfig): void;
  (e: 'edit', bot: BotConfig): void;
  (e: 'history', bot: BotConfig): void;
  (e: 'delete', id: number): void;
}>();

const $q = useQuasar();

const { start, stop } = useSpreadMonitor();
const spreadStats = ref<SpreadStats | undefined>();
const info = ref<BotExchangeInfo | null>(null);

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance Futures',
  mexc_futures: 'Mexc Futures',
};

const formatExchange = (ex: string) => exchangeLabels[ex] || ex;

const formatCountdown = (timestamp: number) => {
  const diff = timestamp - Date.now();
  if (diff <= 0) return '00:00:00';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

let countdownInterval: number;
const nextFundingTimePrimary = ref('00:00:00');
const nextFundingTimeSecondary = ref('00:00:00');

const localAmount = ref(props.bot.coin_amount);
const isAmountFocused = ref(false);

const formatNum = (val: number) => {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 5 }).format(val);
};

const formatUsdt = (val: number) => {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(val);
};

const displayAmount = ref(formatNum(props.bot.coin_amount));

const onFocusAmount = () => {
  isAmountFocused.value = true;
  displayAmount.value = localAmount.value.toString();
};

const onBlurAmount = () => {
  isAmountFocused.value = false;
  displayAmount.value = formatNum(localAmount.value);
};

const amountInputChanged = (val: string | number | null) => {
  if (val === null) return;
  const parsed = parseFloat(val.toString().replace(/\s/g, '').replace(',', '.'));
  if (!isNaN(parsed)) {
    localAmount.value = parsed;
    debouncedSaveAmount();
  }
};

let saveTimeout: number | undefined;

const debouncedSaveAmount = () => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = window.setTimeout(async () => {
    if (localAmount.value !== props.bot.coin_amount) {
      const original = props.bot.coin_amount;
      try {
        await botConfigApi.update(props.bot.id, { coin_amount: localAmount.value });
        $q.notify({ color: 'positive', message: 'Количество сохранено', position: 'top-right', timeout: 1500 });
      } catch (e) {
        $q.notify({ color: 'negative', message: 'Ошибка при сохранении количества' });
        localAmount.value = original;
      }
    }
  }, 2000);
};

watch(() => props.bot.coin_amount, (val) => {
  localAmount.value = val;
  if (!isAmountFocused.value) {
    displayAmount.value = formatNum(val);
  }
});

onMounted(async () => {
  spreadStats.value = start(props.bot.id, props.bot.coin, props.bot.primary_exchange, props.bot.secondary_exchange);
  info.value = await exchangeInfoService.getInfo(props.bot.coin, props.bot.primary_exchange, props.bot.secondary_exchange);

  countdownInterval = window.setInterval(() => {
    if (info.value?.primary) nextFundingTimePrimary.value = formatCountdown(info.value.primary.nextFundingTimestamp);
    if (info.value?.secondary) nextFundingTimeSecondary.value = formatCountdown(info.value.secondary.nextFundingTimestamp);
  }, 1000);
});

onUnmounted(() => {
  stop(props.bot.id);
  window.clearInterval(countdownInterval);
});
</script>

<style lang="sass" scoped>
.bot-card
  border-color: $blue-dark
  transition: opacity 0.2s
  width: 100%
  border-radius: $generic-border-radius

.inactive-card
  opacity: 0.6

.bg-surface
  background-color: rgba(255, 255, 255, 0.03)

.border-radius-sm
  border-radius: 6px

.border-top-dark
  border-top: 1px solid $blue-dark

.status-dot
  width: 8px
  height: 8px
  border-radius: 50%
  background: $negative
  box-shadow: 0 0 8px rgba(255, 93, 107, 0)
  transition: all 0.3s
  &.active-dot
    background: $positive
    box-shadow: 0 0 8px rgba(131, 199, 100, 0.5)

.opacity-70
  opacity: 0.7
.opacity-50
  opacity: 0.5
.opacity-30
  opacity: 0.3
</style>

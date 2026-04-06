<template>
  <q-card flat bordered class="bot-card bg-dark text-text-color line-height-normal" :class="!bot.is_active ? 'inactive-card' : ''">
    <!-- Header -->
    <q-card-section class="q-pb-none">
      <div class="row items-center justify-between q-mb-sm">
        <div class="row items-center">
          <q-badge color="primary" class="q-mr-sm text-weight-bold" style="font-size: 13px">{{ bot.coin }}</q-badge>
          <q-badge :color="bot.order_type === 'buy' ? 'positive' : 'negative'" text-color="dark" class="text-weight-bold" style="font-size: 11px">
            {{ bot.order_type === 'buy' ? 'LONG' : 'SHORT' }}
          </q-badge>
        </div>
        <div class="row items-center">
          <span v-if="!bot.is_active" class="text-caption text-weight-bold text-negative q-mr-sm opacity-80" style="font-size: 10px">ОСТАНОВЛЕН</span>
          <span v-else class="text-caption text-weight-bold text-positive q-mr-sm opacity-80" style="font-size: 10px">РАБОТАЕТ</span>
          <div class="status-dot" :class="{ 'active-dot': bot.is_active }"></div>
        </div>
      </div>
      
      <!-- Exchanges -> Actions Display -->
      <div class="row items-center text-caption text-weight-bold bg-surface q-pa-xs border-radius-sm q-mb-xs">
         <div class="col-5">
           <div class="text-center" :class="bot.order_type === 'buy' ? 'text-positive' : 'text-negative'" style="line-height: 1.1">
             <div class="opacity-70" style="font-size: 10px">{{ formatExchange(bot.primary_exchange) }}</div>
             <div style="font-size: 11px">{{ bot.order_type === 'buy' ? 'ПОКУПКА' : 'ПРОДАЖА' }}</div>
           </div>
         </div>
         <div class="col-2 text-center opacity-50" style="font-size: 10px"></div>
         <div class="col-5">
           <div class="text-center" :class="bot.order_type === 'buy' ? 'text-negative' : 'text-positive'" style="line-height: 1.1">
             <div class="opacity-70" style="font-size: 10px">{{ formatExchange(bot.secondary_exchange) }}</div>
             <div style="font-size: 11px">{{ bot.order_type === 'buy' ? 'ПРОДАЖА' : 'ПОКУПКА' }}</div>
           </div>
         </div>
      </div>
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
        <div class="row q-col-gutter-sm q-mb-md q-mt-xs">
          <div class="col-6">
            <!-- Entry Block -->
            <div class="bg-dark q-pa-sm full-height border-radius-sm relative-position column justify-between" 
                 :style="{ borderLeft: spreadStats.current.openSpread >= bot.entry_spread ? '3px solid #21ba45' : '3px solid rgba(255,255,255,0.1)', borderTop: '1px solid rgba(255,255,255,0.05)', borderRight: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)' }">
              <div>
                <div class="row justify-between items-center q-mb-xs">
                  <span class="opacity-70 text-weight-bold" style="font-size: 10px">ОТКРЫТИЕ ТРЕЙДА</span>
                  <div>
                    <q-icon name="help_outline" class="cursor-pointer opacity-50 hover-opacity-100" size="14px" @click="showSpreadHelp = true" />
                  </div>
                </div>
                <div class="text-h6 text-weight-bold" :class="spreadStats.current.openSpread >= bot.entry_spread ? 'text-positive' : 'text-white'" style="line-height: 1.2">
                  {{ spreadStats.current.openSpread.toFixed(3) }}%
                </div>
              </div>
              <div class="row justify-between items-center q-mt-xs" style="font-size: 11px">
                <div class="row items-center cursor-pointer hover-opacity-100" :class="spreadStats.current.openSpread >= localEntrySpread ? 'text-positive' : 'opacity-50'">
                  <span>Цель: >= {{ localEntrySpread }}%</span>
                  <q-icon name="edit" size="10px" class="q-ml-xs" />
                  <q-popup-edit v-model.number="localEntrySpread" v-slot="scope" class="bg-bg-color text-white border-radius-sm border-dark" auto-save @save="debouncedSaveSettings">
                    <q-input v-model.number="scope.value" type="number" dense dark autofocus color="primary" label="Спред входа (%)" @keyup.enter="scope.set" />
                  </q-popup-edit>
                </div>
                <div v-if="maxOpenSpread > -Infinity" class="text-warning text-weight-bold" style="font-size: 10px">
                  Макс: {{ maxOpenSpread.toFixed(3) }}%
                </div>
              </div>
            </div>
          </div>
          <div class="col-6">
            <!-- Exit Block -->
            <div class="bg-dark q-pa-sm full-height border-radius-sm relative-position column justify-between"
                 :style="{ borderLeft: '3px solid rgba(255,255,255,0.1)', borderTop: '1px solid rgba(255,255,255,0.05)', borderRight: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)' }">
              <div>
                <div class="row justify-between items-center q-mb-xs">
                  <span class="opacity-70 text-weight-bold" style="font-size: 10px">ЗАКРЫТИЕ ТРЕЙДА</span>
                  <div>
                    <q-icon name="help_outline" class="invisible" size="14px" />
                  </div>
                </div>
                <div class="text-h6 text-weight-bold text-white" style="line-height: 1.2">
                  {{ spreadStats.current.closeSpread.toFixed(3) }}%
                </div>
              </div>
              <div class="row justify-between items-center q-mt-xs" style="font-size: 11px">
                <div class="row items-center cursor-pointer hover-opacity-100 opacity-50">
                  <span>Цель: &lt;= {{ localExitSpread }}%</span>
                  <q-icon name="edit" size="10px" class="q-ml-xs" />
                  <q-popup-edit v-model.number="localExitSpread" v-slot="scope" class="bg-bg-color text-white border-radius-sm border-dark" auto-save @save="debouncedSaveSettings">
                    <q-input v-model.number="scope.value" type="number" dense dark autofocus color="primary" label="Спред выхода (%)" @keyup.enter="scope.set" />
                  </q-popup-edit>
                </div>
                <div v-if="minCloseSpread < Infinity" class="text-warning text-weight-bold" style="font-size: 10px">
                  Мин: {{ minCloseSpread.toFixed(3) }}%
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <!-- NEW TRADE INFO BLOCK -->
        <div class="bg-dark q-pa-sm full-width border-radius-sm relative-position q-mt-xs"
             :style="{ minHeight: '48px', border: tradeState === 'in_trade' ? '1px solid rgba(242,192,55,0.4)' : '1px solid rgba(255,255,255,0.05)' }">
          <div class="row justify-between items-center">
            <div class="row items-center q-gutter-x-sm">
              <q-badge color="transparent" class="text-weight-bold" :class="tradeState === 'in_trade' ? 'text-warning' : 'text-grey-6'" :style="{ fontSize: '10px', padding: '4px 6px', boxShadow: tradeState === 'in_trade' ? '0 0 0 1px rgba(242,192,55,0.4) inset' : '0 0 0 1px rgba(255,255,255,0.15) inset' }">
                Статус: {{ tradeState === 'in_trade' ? 'В сделке' : 'Ожидание' }}
              </q-badge>
              <q-badge color="transparent" class="text-weight-bold cursor-pointer hover-opacity-100" :class="tradesCount > 0 ? 'text-positive' : 'text-grey-6'" :style="{ fontSize: '10px', padding: '4px 6px', boxShadow: tradesCount > 0 ? '0 0 0 1px rgba(33,186,69,0.3) inset' : '0 0 0 1px rgba(255,255,255,0.15) inset' }" @click="showTradesHistory = true">
                Трейдов: {{ tradesCount }}
              </q-badge>
            </div>
            
            <div v-if="tradeState === 'in_trade' && activeTrade && spreadStats?.current" class="row items-center q-gutter-x-md">
              <div class="text-caption text-weight-bold" :class="currentPnL > 0 ? 'text-positive' : 'text-negative'" style="font-size: 11px">
                PnL: {{ currentPnL > 0 ? '+' : '' }}{{ currentPnL.toFixed(3) }}%
              </div>
              <q-btn flat round color="negative" size="sm" icon="close" @click="closeManual">
                <q-tooltip class="bg-dark text-white border-radius-sm">Закрыть сделку вручную</q-tooltip>
              </q-btn>
            </div>
            <div v-else class="opacity-50" style="font-size: 11px">
              Нет активных сделок
            </div>
          </div>
        </div>
        
        <SpreadChart :history="spreadStats.history" class="q-my-sm" />

        <!-- Info Table -->
        <div class="exchange-info bg-surface q-pa-sm q-mt-sm border-radius-sm text-caption">
          <div class="row text-weight-bold q-mb-xs">
            <div class="col-4"></div>
            <div class="col-4 text-center" :class="spreadStats.insufficientExchanges?.includes(bot.primary_exchange) ? 'warning-glow' : 'opacity-50'">{{ formatExchange(bot.primary_exchange) }}</div>
            <div class="col-4 text-center" :class="spreadStats.insufficientExchanges?.includes(bot.secondary_exchange) ? 'warning-glow' : 'opacity-50'">{{ formatExchange(bot.secondary_exchange) }}</div>
          </div>
          
          <!-- Открытие -->
          <div class="row q-mb-sm items-center">
            <div class="col-4 opacity-70" style="line-height: 1.1">Открытие<br><span style="font-size: 10px" class="opacity-50">Текущие цены</span></div>
            <div class="col-4 text-center">
              <div style="font-size: 11px" :class="bot.order_type === 'buy' ? 'text-positive text-weight-bold' : 'text-negative text-weight-bold'">
                {{ bot.order_type === 'buy' ? 'Покупка (Ask)' : 'Продажа (Bid)' }}
              </div>
              <div class="text-weight-bold">{{ bot.order_type === 'buy' ? spreadStats.primaryAsk.toFixed(5) : spreadStats.primaryBid.toFixed(5) }}</div>
            </div>
            <div class="col-4 text-center">
              <div style="font-size: 11px" :class="bot.order_type === 'buy' ? 'text-negative text-weight-bold' : 'text-positive text-weight-bold'">
                {{ bot.order_type === 'buy' ? 'Продажа (Bid)' : 'Покупка (Ask)' }}
              </div>
              <div class="text-weight-bold">{{ bot.order_type === 'buy' ? spreadStats.secondaryBid.toFixed(5) : spreadStats.secondaryAsk.toFixed(5) }}</div>
            </div>
          </div>

          <!-- Закрытие -->
          <div class="row q-mb-xs items-center">
            <div class="col-4 opacity-70" style="line-height: 1.1">Закрытие<br><span style="font-size: 10px" class="opacity-50">Для сужения</span></div>
            <div class="col-4 text-center opacity-70">
              <div style="font-size: 11px" :class="bot.order_type === 'buy' ? 'text-negative' : 'text-positive'">
                 {{ bot.order_type === 'buy' ? 'Продажа (Bid)' : 'Покупка (Ask)' }}
              </div>
              <div class="text-weight-medium">{{ bot.order_type === 'buy' ? spreadStats.primaryBid.toFixed(5) : spreadStats.primaryAsk.toFixed(5) }}</div>
            </div>
            <div class="col-4 text-center opacity-70">
              <div style="font-size: 11px" :class="bot.order_type === 'buy' ? 'text-positive' : 'text-negative'">
                {{ bot.order_type === 'buy' ? 'Покупка (Ask)' : 'Продажа (Bid)' }}
              </div>
              <div class="text-weight-medium">{{ bot.order_type === 'buy' ? spreadStats.secondaryAsk.toFixed(5) : spreadStats.secondaryBid.toFixed(5) }}</div>
            </div>
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
      <!-- Spread target stats moved to the top graph header -->

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

      <!-- <div class="row items-center justify-between">
        <div class="text-weight-bold opacity-50">Направление сделки</div>
        <div class="text-weight-bold" :class="bot.order_type === 'buy' ? 'text-positive' : 'text-negative'">
          {{ bot.order_type === 'buy' ? 'LONG на Осн. бирже' : 'SHORT на Осн. бирже' }}
        </div>
      </div> -->
    </q-card-section>

    <!-- Actions -->
    <q-card-actions align="right" class="border-top-dark q-pt-sm q-pb-sm">
      <q-btn flat round dense :icon="bot.is_active ? 'pause' : 'play_arrow'" :color="bot.is_active ? 'warning' : 'positive'" @click="emit('toggle', bot)" />
      <q-btn flat round dense icon="history" color="info" @click="showTradesHistory = true" />
      <q-btn flat round dense icon="edit" color="primary" @click="emit('edit', bot)" />
      <q-btn flat round dense icon="delete" color="negative" @click="emit('delete', bot.id)" />
    </q-card-actions>

    <q-dialog v-model="showSpreadHelp">
      <q-card dark class="bg-dark border-radius-sm border-dark" style="max-width: 500px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6 text-title-color">Как рассчитывается спред?</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section class="q-pt-md text-body2 opacity-80" style="line-height: 1.5">
          <p>
            Этот бот реализует <strong>межбиржевой арбитраж</strong>. Он <strong>одновременно открывает две встречные сделки</strong> на разных биржах: покупает монету там, где она дешевле, и тут же продает (шортит) там, где она дороже. Заработок формируется, когда цены на биржах "сближаются" (спред сужается).
          </p>
          <p class="q-mb-sm">
            <strong class="text-positive">СПРЕД ВХОДА</strong> — прибыль (или разница), которую мы технически фиксируем при немедленном ударе в рынок (направление: "{{ bot.order_type === 'buy' ? 'LONG на основной бирже' : 'SHORT на основной бирже' }}"). Вы задали Цель в <strong>{{ bot.entry_spread }}%</strong>. Как только этот показатель достигнет или превысит вашу цель, бот отправит ордера на открытие позиций.
          </p>
          <p>
            <strong class="text-negative">СПРЕД ВЫХОДА</strong> — текущее "отставание" или разница цен для обратного закрытия сделки. Изначально этот процент всегда отрицательный из-за комиссий и разницы между Ask и Bid (ведь мы покупаем дороже, а продаем дешевле). Бот ждет, пока цены сойдутся и спред выхода достигнет вашей Цели (<strong>{{ bot.exit_spread }}%</strong>), чтобы закрыть обе сделки в совокупный плюс.
          </p>
          <p class="text-caption text-warning q-mt-md">
            * <strong>Важно про Объем:</strong> Данные графики — это не просто абстрактные идеальные цены лучших ордеров с биржи. Наша формула выгребает весь стакан заявок ("съедает" объемы) вплоть до достижения указанного вами <strong>Количества монет</strong>. Это дает вам кристально точный расчет спреда, уже включающий весь проскальзывающий убыток (slippage)!
          </p>
        </q-card-section>
      </q-card>
    </q-dialog>

    <BotTradesDialog v-model="showTradesHistory" :botId="bot.id" />
  </q-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import type { BotConfig, EmulationTrade } from 'src/stores/bots/api/botConfig';
import { botTradesApi } from 'src/stores/bots/api/botConfig';
import { useSpreadMonitor, type SpreadStats } from 'src/stores/exchanges/spreadMonitor';
import type { BotExchangeInfo } from 'src/stores/exchanges/api/exchangeInfo';
import { useExchangesStore } from 'src/stores/exchanges/exchanges.store';
import { useBotsStore } from 'src/stores/bots/bots.store';
import SpreadChart from './SpreadChart.vue';
import BotTradesDialog from './BotTradesDialog.vue';
import { useQuasar } from 'quasar';

const props = defineProps<{ bot: BotConfig }>();
const emit = defineEmits<{
  (e: 'toggle', bot: BotConfig): void;
  (e: 'edit', bot: BotConfig): void;
  (e: 'history', bot: BotConfig): void;
  (e: 'delete', id: number): void;
}>();

const $q = useQuasar();
const exchangesStore = useExchangesStore();
const botsStore = useBotsStore();

const { start, stop, setAmount, setOrderType } = useSpreadMonitor();
const spreadStats = ref<SpreadStats | undefined>();
const info = ref<BotExchangeInfo | null>(null);
const showSpreadHelp = ref(false);
const showTradesHistory = ref(false);

const tradesCount = ref(0);
const tradeState = ref<'idle' | 'in_trade'>('idle');
const activeTrade = ref<EmulationTrade | null>(null);
const maxOpenSpread = ref(-Infinity);
const minCloseSpread = ref(Infinity);

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance Futures',
  binance_spot: 'Binance Spot',
  bybit_futures: 'Bybit Futures',
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
    setAmount(props.bot.id, parsed);
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
        await botsStore.updateBot(props.bot.id, { coin_amount: localAmount.value });
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

const localEntrySpread = ref(Number(props.bot.entry_spread));
const localExitSpread = ref(Number(props.bot.exit_spread));

let saveSettingsTimeout: number | undefined;
const debouncedSaveSettings = () => {
  if (saveSettingsTimeout) clearTimeout(saveSettingsTimeout);
  saveSettingsTimeout = window.setTimeout(async () => {
    if (localEntrySpread.value !== Number(props.bot.entry_spread) || localExitSpread.value !== Number(props.bot.exit_spread)) {
      try {
        await botsStore.updateBot(props.bot.id, { 
          entry_spread: localEntrySpread.value, 
          exit_spread: localExitSpread.value 
        });
        $q.notify({ color: 'positive', message: 'Спреды сохранены', position: 'top-right', timeout: 1500 });
      } catch (e) {
        $q.notify({ color: 'negative', message: 'Ошибка при сохранении спредов' });
        localEntrySpread.value = Number(props.bot.entry_spread);
        localExitSpread.value = Number(props.bot.exit_spread);
      }
    }
  }, 1500);
};

watch(() => props.bot.entry_spread, (val) => localEntrySpread.value = Number(val));
watch(() => props.bot.exit_spread, (val) => localExitSpread.value = Number(val));

watch(() => props.bot.order_type, (val) => {
  setOrderType(props.bot.id, val);
});

watch(() => spreadStats.value?.current?.openSpread, async (newVal) => {
  if (newVal === undefined) return;
  if (newVal > maxOpenSpread.value) {
    maxOpenSpread.value = newVal;
  }
  if (props.bot.is_active && tradeState.value === 'idle' && newVal >= props.bot.entry_spread && !activeTrade.value) {
    tradeState.value = 'in_trade';
    try {
      if (spreadStats.value?.current) {
        activeTrade.value = await botTradesApi.create({
          bot: props.bot.id,
          amount: Number(Number(props.bot.coin_amount).toFixed(8)),
          primary_open_price: Number(spreadStats.value.current.primaryExecPrice.toFixed(8)),
          secondary_open_price: Number(spreadStats.value.current.secondaryExecPrice.toFixed(8)),
          open_spread: Number(newVal.toFixed(4))
        });
      }
    } catch (e) {
      console.error(e);
      tradeState.value = 'idle';
    }
  }
});

const currentPnL = computed(() => {
  if (!activeTrade.value || !spreadStats.value?.current) return 0;
  if (props.bot.order_type === 'buy') {
    const profitUsdt = 
      (activeTrade.value.secondary_open_price - activeTrade.value.primary_open_price) + 
      (spreadStats.value.primaryBid - spreadStats.value.secondaryAsk);
    return (profitUsdt / activeTrade.value.primary_open_price) * 100;
  } else {
    const profitUsdt = 
      (activeTrade.value.primary_open_price - activeTrade.value.secondary_open_price) + 
      (spreadStats.value.secondaryBid - spreadStats.value.primaryAsk);
    return (profitUsdt / activeTrade.value.secondary_open_price) * 100;
  }
});

watch(() => spreadStats.value?.current?.closeSpread, async (newVal) => {
  if (newVal === undefined) return;
  if (newVal < minCloseSpread.value) {
    minCloseSpread.value = newVal;
  }
  if (tradeState.value === 'in_trade' && newVal <= props.bot.exit_spread && activeTrade.value) {
    const profit = currentPnL.value;
    const currentId = activeTrade.value.id;
    
    tradeState.value = 'idle';
    activeTrade.value = null;

    try {
      if (spreadStats.value?.current) {
        const pClose = props.bot.order_type === 'buy' ? spreadStats.value.primaryBid : spreadStats.value.primaryAsk;
        const sClose = props.bot.order_type === 'buy' ? spreadStats.value.secondaryAsk : spreadStats.value.secondaryBid;

        await botTradesApi.close(currentId, {
          status: 'closed',
          primary_close_price: Number(pClose.toFixed(8)),
          secondary_close_price: Number(sClose.toFixed(8)),
          close_spread: Number(newVal.toFixed(4)),
          profit_percentage: Number(profit.toFixed(4)),
          closed_at: new Date().toISOString()
        });
        tradesCount.value++;
      }
    } catch (e) {
      console.error(e);
      // fallback or retry ideally, but for now log
    }
  }
});

const closeManual = async () => {
  if (!activeTrade.value || tradeState.value !== 'in_trade' || !spreadStats.value?.current) return;
  
  const currentSpread = spreadStats.value.current.closeSpread;
  const profit = currentPnL.value;
  const currentId = activeTrade.value.id;
  
  tradeState.value = 'idle';
  activeTrade.value = null;

  try {
    const pClose = props.bot.order_type === 'buy' ? spreadStats.value.primaryBid : spreadStats.value.primaryAsk;
    const sClose = props.bot.order_type === 'buy' ? spreadStats.value.secondaryAsk : spreadStats.value.secondaryBid;

    await botTradesApi.close(currentId, {
      status: 'closed',
      primary_close_price: Number(pClose.toFixed(8)),
      secondary_close_price: Number(sClose.toFixed(8)),
      close_spread: Number(currentSpread.toFixed(4)),
      profit_percentage: Number(profit.toFixed(4)),
      closed_at: new Date().toISOString()
    });
    tradesCount.value++;
  } catch(e) {
    console.error(e);
  }
};

watch(() => [props.bot.entry_spread, props.bot.exit_spread], () => {
  tradesCount.value = 0;
  tradeState.value = 'idle';
  maxOpenSpread.value = -Infinity;
  minCloseSpread.value = Infinity;
  activeTrade.value = null;
});

onMounted(async () => {
  try {
    const list = await botTradesApi.list(props.bot.id);
    const openTrade = list.find(t => t.status === 'open');
    if (openTrade) {
      activeTrade.value = openTrade;
      tradeState.value = 'in_trade';
    }
    tradesCount.value = list.filter(t => t.status === 'closed').length;
  } catch (e) {
    console.error('Failed to load emulation trades', e);
  }

  spreadStats.value = start(props.bot.id, props.bot.coin, props.bot.primary_exchange, props.bot.secondary_exchange, props.bot.coin_amount, props.bot.order_type);
  info.value = await exchangesStore.fetchExchangeInfo(props.bot.coin, props.bot.primary_exchange, props.bot.secondary_exchange);

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

.warning-glow
  color: #ffb300 !important
  text-shadow: 0 0 5px #ffb300, 0 0 10px #ff9800, 0 0 20px #ff5722
  opacity: 1 !important

.opacity-70
  opacity: 0.7
.opacity-50
  opacity: 0.5
.opacity-30
  opacity: 0.3

.hover-opacity-100:hover
  opacity: 1 !important
  transition: opacity 0.2s
</style>

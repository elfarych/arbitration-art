<template>
  <q-card flat bordered class="bot-card bg-dark text-text-color line-height-normal" :class="!bot.is_active ? 'inactive-card' : ''">
    <!-- Header -->
    <q-card-section class="q-pb-none">
      <div class="row items-center justify-between q-mb-sm">
        <div class="row items-center">
          <q-badge color="primary" class="q-mr-sm text-weight-bold" style="font-size: 13px">{{ coinDisplay }}</q-badge>
          <q-badge :color="bot.order_type === 'buy' ? 'positive' : 'negative'" text-color="dark" class="text-weight-bold" style="font-size: 11px">
            {{ orderTypeLabel }}
          </q-badge>
        </div>
        <div class="row items-center">
          <q-badge
            :color="bot.trade_mode === 'real' ? 'negative' : 'info'"
            text-color="white"
            class="text-weight-bold q-mr-sm"
            :class="bot.trade_mode === 'real' ? 'negative-glow' : ''"
            style="font-size: 10px"
          >
            <q-icon :name="bot.trade_mode === 'real' ? 'local_fire_department' : 'science'" size="12px" class="q-mr-xs" />
            {{ bot.trade_mode === 'real' ? 'РЕАЛЬНАЯ ТОРГОВЛЯ' : 'ЭМУЛЯТОР' }}
          </q-badge>
          <span v-if="!bot.is_active" class="text-caption text-weight-bold text-negative q-mr-sm opacity-80" style="font-size: 10px">ОСТАНОВЛЕН</span>
          <span v-else class="text-caption text-weight-bold text-positive q-mr-sm opacity-80" style="font-size: 10px">РАБОТАЕТ</span>
          <div class="status-dot" :class="{ 'active-dot': bot.is_active }"></div>
        </div>
      </div>

      <!-- Engine sync status — surfaces engine availability/last failure -->
      <div v-if="bot.is_active" class="row items-center q-gutter-x-sm q-mb-xs" style="font-size: 10px">
        <q-badge
          :color="engineBadgeColor"
          text-color="white"
          class="text-weight-bold"
          style="font-size: 10px"
        >
          <q-icon :name="engineBadgeIcon" size="12px" class="q-mr-xs" />
          Engine: {{ engineBadgeLabel }}
        </q-badge>
        <q-tooltip v-if="bot.last_sync_error" class="bg-negative text-white" max-width="320px">
          {{ bot.last_sync_error }}
        </q-tooltip>
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
                 :style="{ borderLeft: spreadStats.current.openSpread >= entrySpreadNum ? '3px solid #21ba45' : '3px solid rgba(255,255,255,0.1)', borderTop: '1px solid rgba(255,255,255,0.05)', borderRight: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)' }">
              <div>
                <div class="row justify-between items-center q-mb-xs">
                  <span class="opacity-70 text-weight-bold" style="font-size: 10px">ОТКРЫТИЕ ТРЕЙДА</span>
                  <div>
                    <q-icon name="help_outline" class="cursor-pointer opacity-50 hover-opacity-100" size="14px" @click="showSpreadHelp = true" />
                  </div>
                </div>
                <div class="text-h6 text-weight-bold" :class="spreadStats.current.openSpread >= entrySpreadNum ? 'text-positive' : 'text-white'" style="line-height: 1.2">
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

        <!-- Active trade summary (read-only — engine is the source of truth) -->
        <div class="bg-dark q-pa-sm full-width border-radius-sm relative-position q-mt-xs"
             :style="{ minHeight: '48px', border: hasActiveTrade ? '1px solid rgba(242,192,55,0.4)' : '1px solid rgba(255,255,255,0.05)' }">
          <div class="row justify-between items-center">
            <div class="row items-center q-gutter-x-sm">
              <q-badge color="transparent" class="text-weight-bold" :class="hasActiveTrade ? 'text-warning' : 'text-grey-6'" :style="{ fontSize: '10px', padding: '4px 6px', boxShadow: hasActiveTrade ? '0 0 0 1px rgba(242,192,55,0.4) inset' : '0 0 0 1px rgba(255,255,255,0.15) inset' }">
                Статус: {{ hasActiveTrade ? 'В сделке' : 'Ожидание' }}
              </q-badge>
              <q-badge color="transparent" class="text-weight-bold cursor-pointer hover-opacity-100" :class="closedTradesCount > 0 ? 'text-positive' : 'text-grey-6'" :style="{ fontSize: '10px', padding: '4px 6px', boxShadow: closedTradesCount > 0 ? '0 0 0 1px rgba(33,186,69,0.3) inset' : '0 0 0 1px rgba(255,255,255,0.15) inset' }" @click="showTradesHistory = true">
                Трейдов: {{ closedTradesCount }}
              </q-badge>
              <q-spinner v-if="tradesLoading" color="primary" size="14px" />
            </div>

            <div v-if="hasActiveTrade && spreadStats?.current" class="row items-center q-gutter-x-md">
              <div class="text-caption text-weight-bold" :class="currentPnL > 0 ? 'text-positive' : 'text-negative'" style="font-size: 11px">
                PnL: {{ currentPnL > 0 ? '+' : '' }}{{ currentPnL.toFixed(3) }}%
              </div>
              <q-btn flat round color="negative" size="sm" icon="close" :loading="forceClosing" @click="confirmForceClose">
                <q-tooltip class="bg-dark text-white border-radius-sm">Отправить engine команду force-close</q-tooltip>
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

    <!-- Amount input — read/display only; PATCH is debounced + locked while saving -->
    <q-card-section class="q-pt-none text-caption q-mt-sm">
      <div class="q-mb-md">
        <q-input
          v-model="displayAmount"
          type="text"
          dense
          outlined
          dark
          label="Количество"
          :loading="amountSaving"
          :disable="amountSaving"
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
    </q-card-section>

    <!-- Actions -->
    <q-card-actions align="right" class="border-top-dark q-pt-sm q-pb-sm">
      <q-btn flat round dense :icon="bot.is_active ? 'pause' : 'play_arrow'" :color="bot.is_active ? 'warning' : 'positive'" @click="emit('toggle', bot)" />
      <q-btn flat round dense icon="history" color="info" @click="showTradesHistory = true" />
      <q-btn flat round dense icon="stop_circle" color="negative" @click="emit('force-close', bot.id)" title="Принудительно закрыть сделки" />
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
            <strong class="text-positive">СПРЕД ВХОДА</strong> — прибыль (или разница), которую мы технически фиксируем при немедленном ударе в рынок (направление: "{{ bot.order_type === 'buy' ? 'LONG на основной бирже' : 'SHORT на основной бирже' }}"). Вы задали Цель в <strong>{{ entrySpreadNum }}%</strong>. Как только этот показатель достигнет или превысит вашу цель, бот отправит ордера на открытие позиций.
          </p>
          <p>
            <strong class="text-negative">СПРЕД ВЫХОДА</strong> — текущее "отставание" или разница цен для обратного закрытия сделки. Изначально этот процент всегда отрицательный из-за комиссий и разницы между Ask и Bid (ведь мы покупаем дороже, а продаем дешевле). Бот ждет, пока цены сойдутся и спред выхода достигнет вашей Цели (<strong>{{ exitSpreadNum }}%</strong>), чтобы закрыть обе сделки в совокупный плюс.
          </p>
          <p class="text-caption text-warning q-mt-md">
            * <strong>Важно про Объем:</strong> Данные графики — это не просто абстрактные идеальные цены лучших ордеров с биржи. Наша формула выгребает весь стакан заявок ("съедает" объемы) вплоть до достижения указанного вами <strong>Количества монет</strong>. Это дает вам кристально точный расчет спреда, уже включающий весь проскальзывающий убыток (slippage)!
          </p>
        </q-card-section>
      </q-card>
    </q-dialog>

    <BotTradesDialog v-model="showTradesHistory" :botId="bot.id" :tradeMode="bot.trade_mode" />
  </q-card>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import type { BotConfig, EmulationTrade, RealTrade } from 'src/stores/bots/api/botConfig';
import { botTradesApi, realTradesApi } from 'src/stores/bots/api/botConfig';
import { useSpreadMonitor, type SpreadStats } from 'src/stores/exchanges/spreadMonitor';
import type { BotExchangeInfo } from 'src/stores/exchanges/api/exchangeInfo';
import { useExchangesStore } from 'src/stores/exchanges/exchanges.store';
import { useBotsStore } from 'src/stores/bots/bots.store';
import SpreadChart from './SpreadChart.vue';
import BotTradesDialog from './BotTradesDialog.vue';
import { useQuasar } from 'quasar';
import { extractApiErrorMessage } from 'src/utils/apiError';

const props = defineProps<{ bot: BotConfig }>();
const emit = defineEmits<{
  (e: 'toggle', bot: BotConfig): void;
  (e: 'edit', bot: BotConfig): void;
  (e: 'history', bot: BotConfig): void;
  (e: 'delete', id: number): void;
  (e: 'force-close', id: number): void;
}>();

const $q = useQuasar();
const exchangesStore = useExchangesStore();
const botsStore = useBotsStore();

const { start, stop, setAmount, setOrderType } = useSpreadMonitor();
const spreadStats = ref<SpreadStats | undefined>();
const info = ref<BotExchangeInfo | null>(null);
const showSpreadHelp = ref(false);
const showTradesHistory = ref(false);
const forceClosing = ref(false);

// Trade state mirrored from Django — engine is the source of truth. Frontend
// only displays what Django reports; it never opens or closes trades itself.
type AnyTrade = EmulationTrade | RealTrade;
const activeTrade = ref<AnyTrade | null>(null);
const closedTradesCount = ref(0);
const tradesLoading = ref(false);
let tradesPollHandle: number | undefined;

const maxOpenSpread = ref(-Infinity);
const minCloseSpread = ref(Infinity);

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance Futures',
  bybit_futures: 'Bybit Futures',
  gate_futures: 'Gate Futures',
  mexc_futures: 'Mexc Futures',
};
const formatExchange = (ex: string) => exchangeLabels[ex] || ex;

const coinDisplay = computed(() => {
  // BotConfig.coin is stored as ccxt format "BTC/USDT:USDT"; show the base
  // ticker for compact card headers.
  const match = /^([A-Z0-9]+)\/USDT:USDT$/i.exec(props.bot.coin);
  return match?.[1] ?? props.bot.coin;
});

const orderTypeLabel = computed(() => {
  if (props.bot.order_type === 'buy') return 'LONG';
  if (props.bot.order_type === 'sell') return 'SHORT';
  return 'AUTO';
});

const entrySpreadNum = computed(() => Number(props.bot.entry_spread));
const exitSpreadNum = computed(() => Number(props.bot.exit_spread));

const engineBadgeColor = computed(() => {
  if (props.bot.sync_status === 'success' && props.bot.status === 'running') return 'positive';
  if (props.bot.sync_status === 'pending') return 'info';
  if (props.bot.sync_status === 'failed') return 'negative';
  return 'grey';
});
const engineBadgeIcon = computed(() => {
  if (props.bot.sync_status === 'success' && props.bot.status === 'running') return 'check_circle';
  if (props.bot.sync_status === 'pending') return 'sync';
  if (props.bot.sync_status === 'failed') return 'error';
  return 'help_outline';
});
const engineBadgeLabel = computed(() => {
  if (props.bot.sync_status === 'failed') return 'не отвечает';
  if (props.bot.sync_status === 'pending') return 'синхронизация…';
  if (props.bot.status === 'running') return 'работает';
  if (props.bot.status === 'starting') return 'старт…';
  if (props.bot.status === 'stopping') return 'остановка…';
  if (props.bot.status === 'stopped') return 'остановлен';
  if (props.bot.status === 'error') return 'ошибка';
  return props.bot.status || 'неизвестно';
});

const formatCountdown = (timestamp: number) => {
  const diff = timestamp - Date.now();
  if (diff <= 0) return '00:00:00';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

let countdownInterval: number | undefined;
const nextFundingTimePrimary = ref('00:00:00');
const nextFundingTimeSecondary = ref('00:00:00');

const localAmount = ref(Number(props.bot.coin_amount));
const isAmountFocused = ref(false);

const formatNum = (val: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(val);
const formatUsdt = (val: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(val);

const displayAmount = ref(formatNum(Number(props.bot.coin_amount)));

const onFocusAmount = () => {
  isAmountFocused.value = true;
  displayAmount.value = String(localAmount.value);
};
const onBlurAmount = () => {
  isAmountFocused.value = false;
  displayAmount.value = formatNum(localAmount.value);
};

const amountInputChanged = (val: string | number | null) => {
  if (val === null) return;
  const parsed = parseFloat(val.toString().replace(/\s/g, '').replace(',', '.'));
  if (!isNaN(parsed) && parsed > 0) {
    localAmount.value = parsed;
    setAmount(props.bot.id, parsed);
    debouncedSaveAmount();
  }
};

const amountSaving = ref(false);
let amountSaveTimeout: number | undefined;
// Longer debounce for active bots: each PATCH triggers an inline engine sync
// (up to SERVICE_LIFECYCLE_TIMEOUT_SECONDS × retries), so saving on every
// keystroke is wasteful and slow.
const AMOUNT_DEBOUNCE_MS = 4000;

const debouncedSaveAmount = () => {
  if (amountSaveTimeout) clearTimeout(amountSaveTimeout);
  amountSaveTimeout = window.setTimeout(async () => {
    if (localAmount.value === Number(props.bot.coin_amount)) return;
    const original = Number(props.bot.coin_amount);
    amountSaving.value = true;
    try {
      await botsStore.updateBot(props.bot.id, { coin_amount: localAmount.value });
      $q.notify({ color: 'positive', message: 'Количество сохранено', position: 'top-right', timeout: 1500 });
    } catch (e) {
      const message = extractApiErrorMessage(e, 'Ошибка при сохранении количества');
      $q.notify({ color: 'negative', message });
      localAmount.value = original;
      displayAmount.value = formatNum(original);
    } finally {
      amountSaving.value = false;
    }
  }, AMOUNT_DEBOUNCE_MS);
};

watch(() => props.bot.coin_amount, (val) => {
  const numeric = Number(val);
  localAmount.value = numeric;
  if (!isAmountFocused.value) {
    displayAmount.value = formatNum(numeric);
  }
});

const localEntrySpread = ref(entrySpreadNum.value);
const localExitSpread = ref(exitSpreadNum.value);

let saveSettingsTimeout: number | undefined;
const debouncedSaveSettings = () => {
  if (saveSettingsTimeout) clearTimeout(saveSettingsTimeout);
  saveSettingsTimeout = window.setTimeout(async () => {
    if (localEntrySpread.value === entrySpreadNum.value && localExitSpread.value === exitSpreadNum.value) return;
    try {
      await botsStore.updateBot(props.bot.id, {
        entry_spread: localEntrySpread.value,
        exit_spread: localExitSpread.value,
      });
      $q.notify({ color: 'positive', message: 'Спреды сохранены', position: 'top-right', timeout: 1500 });
    } catch (e) {
      const message = extractApiErrorMessage(e, 'Ошибка при сохранении спредов');
      $q.notify({ color: 'negative', message });
      localEntrySpread.value = entrySpreadNum.value;
      localExitSpread.value = exitSpreadNum.value;
    }
  }, 1500);
};

watch(entrySpreadNum, (val) => { localEntrySpread.value = val; });
watch(exitSpreadNum, (val) => { localExitSpread.value = val; });

watch(() => props.bot.order_type, (val) => {
  setOrderType(props.bot.id, val);
});

watch(() => spreadStats.value?.current?.openSpread, (newVal) => {
  if (newVal === undefined) return;
  if (newVal > maxOpenSpread.value) maxOpenSpread.value = newVal;
});

watch(() => spreadStats.value?.current?.closeSpread, (newVal) => {
  if (newVal === undefined) return;
  if (newVal < minCloseSpread.value) minCloseSpread.value = newVal;
});

// Multi-source form: Vue compares each getter result independently via
// `Object.is`. A single-getter form returning `[a, b, c]` would compare the
// array by reference and reset on every props.bot re-assignment (which happens
// every 15s when IndexPage polls fetchBots), wiping the rolling extremes.
watch(
  [() => props.bot.entry_spread, () => props.bot.exit_spread, () => props.bot.coin],
  () => {
    maxOpenSpread.value = -Infinity;
    minCloseSpread.value = Infinity;
  },
);

const hasActiveTrade = computed(() => activeTrade.value !== null && (activeTrade.value as AnyTrade).status === 'open');

const currentPnL = computed(() => {
  if (!activeTrade.value || !spreadStats.value?.current) return 0;
  const pOpen = Number(activeTrade.value.primary_open_price);
  const sOpen = Number(activeTrade.value.secondary_open_price);
  if (!pOpen || !sOpen) return 0;
  if (props.bot.order_type === 'buy') {
    const profitUsdt =
      (sOpen - pOpen) +
      (spreadStats.value.primaryBid - spreadStats.value.secondaryAsk);
    return (profitUsdt / pOpen) * 100;
  }
  const profitUsdt =
    (pOpen - sOpen) +
    (spreadStats.value.secondaryBid - spreadStats.value.primaryAsk);
  return (profitUsdt / sOpen) * 100;
});

// Polling configuration: Django returns lists by bot_id (no status filter, so
// we get open + closed + force_closed in one round-trip and partition them
// client-side). Engine writes trades into Django asynchronously via
// api.openTrade / api.openEmulationTrade, so polling is what the UI uses to
// mirror engine state. Lower bound keeps it responsive without saturating the
// Django worker pool.
const TRADE_POLL_MS = 5000;

async function refreshTradeState(initial = false) {
  if (initial) tradesLoading.value = true;
  try {
    const params = { botId: props.bot.id } as const;
    // Single query without status filter so the counter picks up every
    // terminal state. Real-mode trades use `closed` for profit/shutdown and
    // `force_closed` for force-close/timeout/liquidation/error; emulator
    // trades always end as `closed` (see BotTrader.executeClose), but
    // existing rows from earlier builds may still carry `force_closed` and
    // would be miscounted as "open" by a status=closed filter.
    const all: AnyTrade[] = props.bot.trade_mode === 'real'
      ? await realTradesApi.list({ ...params })
      : await botTradesApi.list({ ...params });
    activeTrade.value = all.find(t => t.status === 'open') ?? null;
    closedTradesCount.value = all.reduce(
      (count, t) => count + (t.status !== 'open' ? 1 : 0),
      0,
    );
  } catch (e) {
    if (initial) {
      console.error('Failed to load trades for bot', props.bot.id, e);
    }
  } finally {
    if (initial) tradesLoading.value = false;
  }
}

function confirmForceClose() {
  $q.dialog({
    title: 'Закрыть сделку',
    message: 'Отправить engine команду на закрытие текущей сделки?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'warning',
  }).onOk(async () => {
    forceClosing.value = true;
    try {
      await botsStore.forceCloseBot(props.bot.id);
      $q.notify({ color: 'positive', message: 'Команда force-close отправлена' });
      // Engine close is asynchronous: it can spend up to ~10s clearing the
      // busy state and submitting reduceOnly orders. Rather than busy-polling
      // (which previously fired ~20 requests in 15s and spammed Django when
      // the close stalled on the engine side), rely on the regular 5s trade
      // poll set up in onMounted to pick up the new state.
    } catch (e) {
      $q.notify({ color: 'negative', message: extractApiErrorMessage(e, 'Не удалось отправить команду') });
    } finally {
      forceClosing.value = false;
    }
  });
}

onMounted(async () => {
  spreadStats.value = start(
    props.bot.id,
    coinDisplay.value,
    props.bot.primary_exchange,
    props.bot.secondary_exchange,
    Number(props.bot.coin_amount),
    props.bot.order_type,
  );
  info.value = await exchangesStore.fetchExchangeInfo(coinDisplay.value, props.bot.primary_exchange, props.bot.secondary_exchange);

  await refreshTradeState(true);
  tradesPollHandle = window.setInterval(() => { void refreshTradeState(); }, TRADE_POLL_MS);

  countdownInterval = window.setInterval(() => {
    if (info.value?.primary) nextFundingTimePrimary.value = formatCountdown(info.value.primary.nextFundingTimestamp);
    if (info.value?.secondary) nextFundingTimeSecondary.value = formatCountdown(info.value.secondary.nextFundingTimestamp);
  }, 1000);
});

onUnmounted(() => {
  stop(props.bot.id);
  if (countdownInterval) window.clearInterval(countdownInterval);
  if (tradesPollHandle) window.clearInterval(tradesPollHandle);
  if (amountSaveTimeout) window.clearTimeout(amountSaveTimeout);
  if (saveSettingsTimeout) window.clearTimeout(saveSettingsTimeout);
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

.negative-glow
  box-shadow: 0 0 8px rgba(193, 0, 21, 0.6), 0 0 15px rgba(193, 0, 21, 0.4) !important
  animation: pulse-red 2s infinite

@keyframes pulse-red
  0%
    box-shadow: 0 0 0 0 rgba(193, 0, 21, 0.7)
  70%
    box-shadow: 0 0 0 6px rgba(193, 0, 21, 0)
  100%
    box-shadow: 0 0 0 0 rgba(193, 0, 21, 0)

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

<template>
  <q-page padding class="pnl-page">
    <div class="row items-center justify-between q-mb-lg">
      <h1 class="text-h5 text-title-color text-weight-bold q-my-none">PnL</h1>
      <q-btn flat no-caps icon="refresh" color="primary" :loading="loading" @click="refresh">
        Обновить
      </q-btn>
    </div>

    <!-- Period + filters -->
    <q-card flat class="bg-dark border-radius-sm border-dark q-mb-lg">
      <q-card-section class="row q-col-gutter-md items-end">
        <div class="col-12 col-sm-4 col-md-3">
          <q-select
            v-model="period"
            :options="periodOptions"
            label="Период"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
            @update:model-value="onPeriodChange"
          />
        </div>

        <template v-if="period === 'custom'">
          <div class="col-12 col-sm-4 col-md-3">
            <q-input
              v-model="customFromDate"
              label="От"
              dark
              outlined
              dense
              type="date"
              @update:model-value="onCustomChange"
            />
          </div>
          <div class="col-12 col-sm-4 col-md-3">
            <q-input
              v-model="customToDate"
              label="До"
              dark
              outlined
              dense
              type="date"
              @update:model-value="onCustomChange"
            />
          </div>
        </template>

        <div class="col-12 col-sm-4 col-md-3">
          <q-select
            v-model="tradeMode"
            :options="modeOptions"
            label="Тип торговли"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
            @update:model-value="refresh"
          />
        </div>

        <div class="col-12 col-sm-4 col-md-3">
          <q-select
            v-model="botId"
            :options="botOptions"
            label="Бот"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
            clearable
            @update:model-value="refresh"
          />
        </div>
      </q-card-section>

      <q-card-section v-if="rangeLabel" class="q-pt-none text-caption opacity-70">
        {{ rangeLabel }}
      </q-card-section>
    </q-card>

    <!-- Summary cards -->
    <div class="row q-col-gutter-md q-mb-lg">
      <div class="col-12 col-sm-6 col-md-3">
        <PnlStatCard
          title="Всего PnL"
          :value="formatUsdt(totalPnl)"
          unit="USDT"
          :color-class="totalPnl > 0 ? 'text-positive' : totalPnl < 0 ? 'text-negative' : 'text-text-color'"
          :loading="loading && !summary"
          icon="paid"
        />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <PnlStatCard
          title="Сделок"
          :value="String(totalTrades)"
          :unit="winRateLabel"
          color-class="text-text-color"
          :loading="loading && !summary"
          icon="swap_horiz"
        />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <PnlStatCard
          title="Прибыльных"
          :value="String(totalWins)"
          :unit="totalLosses > 0 ? `· убыточных: ${totalLosses}` : ''"
          color-class="text-positive"
          :loading="loading && !summary"
          icon="trending_up"
        />
      </div>
      <div class="col-12 col-sm-6 col-md-3">
        <PnlStatCard
          title="Реал / Эмулятор"
          :value="`${formatUsdt(realPnl)} / ${formatUsdt(emuPnl)}`"
          unit="USDT"
          color-class="text-text-color"
          :loading="loading && !summary"
          icon="account_balance"
        />
      </div>
    </div>

    <!-- Per-bot breakdown -->
    <q-card flat class="bg-dark border-radius-sm border-dark">
      <q-card-section class="row items-center justify-between q-pb-none">
        <div class="text-subtitle1 text-title-color text-weight-bold">Разбивка по ботам</div>
        <div v-if="byBot.length > 0" class="text-caption opacity-70">{{ byBot.length }} активных строк</div>
      </q-card-section>
      <q-card-section>
        <q-table
          :rows="byBot"
          :columns="columns"
          row-key="bot_id"
          dark
          flat
          dense
          class="bg-transparent pnl-table"
          :loading="loading"
          :pagination="pagination"
          table-header-class="text-grey-6 text-weight-bold"
          :no-data-label="emptyLabel"
          @row-click="onRowClick"
        >
          <template v-slot:body-cell-coin="props">
            <q-td :props="props">
              <q-badge color="primary" class="text-weight-bold q-mr-xs" style="font-size: 11px">{{ formatCoin(props.row.coin) }}</q-badge>
              <q-badge
                :color="props.row.trade_mode === 'real' ? 'negative' : 'info'"
                text-color="white"
                class="text-weight-bold"
                style="font-size: 9px"
              >
                {{ props.row.trade_mode === 'real' ? 'РЕАЛ' : 'ЭМУ' }}
              </q-badge>
            </q-td>
          </template>

          <template v-slot:body-cell-route="props">
            <q-td :props="props" class="text-caption opacity-80">
              {{ formatExchange(props.row.primary_exchange) }} → {{ formatExchange(props.row.secondary_exchange) }}
            </q-td>
          </template>

          <template v-slot:body-cell-pnl="props">
            <q-td :props="props" class="text-weight-bold" :class="numericClass(parseFloat(props.row.profit_usdt))">
              {{ formatUsdtSigned(parseFloat(props.row.profit_usdt)) }}
            </q-td>
          </template>

          <template v-slot:body-cell-winrate="props">
            <q-td :props="props">
              <span class="text-positive">{{ props.row.wins }}</span>
              <span class="opacity-50"> / </span>
              <span class="text-negative">{{ props.row.losses }}</span>
              <span class="opacity-50 q-ml-xs" style="font-size: 11px">
                ({{ winRate(props.row.wins, props.row.trades_count) }}%)
              </span>
            </q-td>
          </template>

          <template v-slot:body-cell-status="props">
            <q-td :props="props">
              <q-badge :color="props.row.is_active ? 'positive' : 'grey-7'" text-color="white" style="font-size: 9px">
                {{ props.row.is_active ? 'РАБОТАЕТ' : 'ОСТАНОВЛЕН' }}
              </q-badge>
            </q-td>
          </template>
        </q-table>
      </q-card-section>
    </q-card>

    <!-- Always mounted (no v-if): BotTradesDialog only fetches on the
         modelValue false→true watcher, so a v-if=botId mount on the first
         click would arrive with modelValue=true already set and skip the
         fetch (it would only run on the second open). -->
    <BotTradesDialog
      v-model="dialogOpen"
      :botId="dialogBotId ?? 0"
      :tradeMode="dialogTradeMode"
    />
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { usePnlStore } from 'src/stores/pnl/pnl.store';
import { useBotsStore } from 'src/stores/bots/bots.store';
import { storeToRefs } from 'pinia';
import { rangeForPeriod, PERIOD_LABELS, type PnlPeriodKey } from 'src/stores/pnl/periods';
import { extractApiErrorMessage } from 'src/utils/apiError';
import PnlStatCard from 'src/components/pnl/PnlStatCard.vue';
import BotTradesDialog from 'src/components/bots/BotTradesDialog.vue';
import type { PnlByBotEntry } from 'src/stores/pnl/api/pnl';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const pnlStore = usePnlStore();
const botsStore = useBotsStore();
const { bots } = storeToRefs(botsStore);

const dialogOpen = ref(false);
const dialogBotId = ref<number | null>(null);
const dialogTradeMode = ref<'real' | 'emulator' | undefined>(undefined);

const onRowClick = (_evt: Event, row: PnlByBotEntry) => {
  dialogBotId.value = row.bot_id;
  dialogTradeMode.value = row.trade_mode;
  dialogOpen.value = true;
};

const period = ref<PnlPeriodKey>('month');
const customFromDate = ref<string>('');
const customToDate = ref<string>('');
const tradeMode = ref<'all' | 'real' | 'emulator'>('all');
const botId = ref<number | null>(null);

const summary = computed(() => pnlStore.current);
const loading = computed(() => pnlStore.currentLoading);
const byBot = computed(() => summary.value?.by_bot ?? []);
const totalPnl = computed(() => parseFloat(summary.value?.total?.profit_usdt ?? '0') || 0);
const realPnl = computed(() => parseFloat(summary.value?.real?.profit_usdt ?? '0') || 0);
const emuPnl = computed(() => parseFloat(summary.value?.emulator?.profit_usdt ?? '0') || 0);
const totalTrades = computed(() => summary.value?.total?.trades_count ?? 0);
const totalWins = computed(() => summary.value?.total?.wins ?? 0);
const totalLosses = computed(() => summary.value?.total?.losses ?? 0);
const winRateLabel = computed(() => {
  if (totalTrades.value === 0) return '';
  const rate = summary.value?.total?.win_rate ?? 0;
  return `winrate ${rate.toFixed(1)}%`;
});

const exchangeLabels: Record<string, string> = {
  binance_futures: 'Binance',
  bybit_futures: 'Bybit',
  gate_futures: 'Gate',
  mexc_futures: 'Mexc',
};
const formatExchange = (ex: string) => exchangeLabels[ex] || ex;
const formatCoin = (raw: string) => /^([A-Z0-9]+)\/USDT:USDT$/i.exec(raw)?.[1] ?? raw;

const periodOptions = (Object.keys(PERIOD_LABELS) as PnlPeriodKey[]).map((key) => ({
  label: PERIOD_LABELS[key],
  value: key,
}));

const modeOptions = [
  { label: 'Все', value: 'all' },
  { label: 'Реальные', value: 'real' },
  { label: 'Эмулятор', value: 'emulator' },
];

const botOptions = computed(() =>
  bots.value.map((bot) => ({
    label: `${formatCoin(bot.coin)} · ${bot.trade_mode === 'real' ? 'РЕАЛ' : 'ЭМУ'}`,
    value: bot.id,
  })),
);

const columns = [
  { name: 'coin', label: 'Бот', field: 'coin', align: 'left', sortable: false },
  { name: 'route', label: 'Маршрут', field: 'primary_exchange', align: 'left' },
  { name: 'trades', label: 'Сделок', field: 'trades_count', align: 'right', sortable: true },
  { name: 'pnl', label: 'PnL', field: (row: { profit_usdt: string }) => parseFloat(row.profit_usdt), align: 'right', sortable: true },
  { name: 'winrate', label: 'Прибыль / Убыток', field: 'wins', align: 'left' },
  { name: 'status', label: 'Статус', field: 'is_active', align: 'center' },
] as const;

const pagination = { rowsPerPage: 25, sortBy: 'pnl', descending: true };

const emptyLabel = computed(() => {
  if (loading.value) return 'Загрузка…';
  if (pnlStore.currentError) return pnlStore.currentError;
  return 'За выбранный период закрытых сделок нет.';
});

const numericClass = (v: number) => (v > 0 ? 'text-positive' : v < 0 ? 'text-negative' : 'opacity-70');

const formatUsdt = (v: number) =>
  new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
const formatUsdtSigned = (v: number) => {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${formatUsdt(Math.abs(v))}`;
};
const winRate = (wins: number, total: number) => (total === 0 ? '0' : ((wins / total) * 100).toFixed(0));

const formatDateLabel = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

const rangeLabel = computed(() => {
  const range = currentRange.value;
  if (period.value === 'all' && !range.from && !range.to) return null;
  return `${formatDateLabel(range.from)} → ${formatDateLabel(range.to)}`;
});

const currentRange = computed(() => {
  if (period.value === 'custom') {
    return {
      from: customFromDate.value ? new Date(`${customFromDate.value}T00:00:00`).toISOString() : null,
      to: customToDate.value ? new Date(`${customToDate.value}T23:59:59.999`).toISOString() : null,
    };
  }
  return rangeForPeriod(period.value);
});

const onPeriodChange = () => {
  if (period.value === 'custom') {
    // Seed custom inputs with the current default month so the user sees a
    // populated range immediately instead of two blank fields.
    if (!customFromDate.value) {
      const monthRange = rangeForPeriod('month');
      if (monthRange.from) customFromDate.value = monthRange.from.slice(0, 10);
    }
    if (!customToDate.value) {
      const today = new Date();
      customToDate.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }
  }
  void refresh();
};

const onCustomChange = () => {
  if (period.value !== 'custom') return;
  if (!customFromDate.value || !customToDate.value) return;
  void refresh();
};

const refresh = async () => {
  const range = currentRange.value;
  try {
    await pnlStore.fetchSummary({
      from: range.from,
      to: range.to,
      bot_id: botId.value ?? undefined,
      trade_mode: tradeMode.value === 'all' ? undefined : tradeMode.value,
    });
  } catch (e) {
    $q.notify({ color: 'negative', message: extractApiErrorMessage(e, 'Не удалось загрузить PnL') });
  }
};

const syncQueryToRoute = () => {
  const next: Record<string, string> = {};
  if (period.value !== 'month') next.period = period.value;
  if (botId.value !== null) next.bot_id = String(botId.value);
  if (tradeMode.value !== 'all') next.trade_mode = tradeMode.value;
  if (period.value === 'custom') {
    if (customFromDate.value) next.from = customFromDate.value;
    if (customToDate.value) next.to = customToDate.value;
  }
  void router.replace({ path: '/pnl', query: next });
};

watch([period, botId, tradeMode, customFromDate, customToDate], syncQueryToRoute);

onMounted(async () => {
  // Hydrate the bot dropdown from the existing bots store. The list may
  // already be cached if the user navigated from IndexPage; otherwise fetch.
  if (bots.value.length === 0) {
    void botsStore.fetchBots({ silent: true });
  }

  const q = route.query;
  if (typeof q.period === 'string' && q.period in PERIOD_LABELS) {
    period.value = q.period as PnlPeriodKey;
  }
  if (typeof q.bot_id === 'string') {
    const parsed = parseInt(q.bot_id, 10);
    if (!Number.isNaN(parsed)) botId.value = parsed;
  }
  if (typeof q.trade_mode === 'string' && ['real', 'emulator'].includes(q.trade_mode)) {
    tradeMode.value = q.trade_mode as 'real' | 'emulator';
  }
  if (period.value === 'custom') {
    if (typeof q.from === 'string') customFromDate.value = q.from;
    if (typeof q.to === 'string') customToDate.value = q.to;
  }

  await refresh();
});
</script>

<style lang="sass" scoped>
.pnl-page
  /* full-width content */

.pnl-table
  :deep(tbody tr)
    cursor: pointer
    transition: background-color 0.15s ease
    &:hover
      background-color: rgba(255, 255, 255, 0.04)

.text-title-color
  color: $title-color !important

.text-text-color
  color: $text-color !important

.border-dark
  border: 1px solid $blue-dark

.border-radius-sm
  border-radius: $generic-border-radius

.opacity-70
  opacity: 0.7
.opacity-80
  opacity: 0.8
.opacity-50
  opacity: 0.5
</style>

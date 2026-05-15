<template>
  <q-btn
    flat
    no-caps
    dense
    class="today-pnl-chip text-weight-medium"
    :class="chipColorClass"
    :title="tooltipText"
    to="/pnl"
  >
    <div class="row items-center q-gutter-x-xs">
      <q-icon name="trending_up" size="14px" />
      <span class="opacity-70 q-mr-xs">Сегодня</span>
      <q-spinner v-if="pnlStore.todayLoading && !pnlStore.today" color="primary" size="12px" />
      <template v-else>
        <span>{{ formattedPnl }} USDT</span>
        <span v-if="tradesCount > 0" class="opacity-50" style="font-size: 11px">
          · {{ tradesCount }}
        </span>
      </template>
    </div>
  </q-btn>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { usePnlStore } from 'src/stores/pnl/pnl.store';

const pnlStore = usePnlStore();

// 60s is enough: trade closes flow into Django the moment the engine PATCHes
// status=closed (see arbitration-bot-engine BotTrader.executeClose), so the
// header lags behind reality by at most one tick. Faster polling would
// hammer Django without user-perceivable benefit.
const POLL_MS = 60_000;
let pollHandle: number | undefined;

const profitUsdt = computed(() => pnlStore.todayProfitUsdt);
const tradesCount = computed(() => pnlStore.todayTradesCount);

const formattedPnl = computed(() => {
  const v = profitUsdt.value;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(v))}`;
});

const chipColorClass = computed(() => {
  if (profitUsdt.value > 0) return 'text-positive';
  if (profitUsdt.value < 0) return 'text-negative';
  return 'text-text-color';
});

const tooltipText = computed(() => {
  if (pnlStore.todayError) return pnlStore.todayError;
  if (tradesCount.value === 0) return 'Сегодня ещё не было закрытых сделок. Нажмите, чтобы перейти на страницу PnL.';
  return `PnL за сегодня · ${tradesCount.value} закрытых сделок. Нажмите, чтобы открыть страницу PnL.`;
});

onMounted(() => {
  void pnlStore.fetchToday({ silent: !!pnlStore.today });
  pollHandle = window.setInterval(() => {
    void pnlStore.fetchToday({ silent: true });
  }, POLL_MS);
});

onUnmounted(() => {
  if (pollHandle) window.clearInterval(pollHandle);
});
</script>

<style lang="sass" scoped>
.today-pnl-chip
  border: 1px solid $blue-dark
  border-radius: $generic-border-radius
  padding: 4px 12px
  font-size: 13px
  min-height: 32px
  transition: background-color 0.2s ease, border-color 0.2s ease
  &:hover
    background-color: rgba(255, 255, 255, 0.04)
    border-color: rgba(255, 255, 255, 0.2)

.text-text-color
  color: $text-color
</style>

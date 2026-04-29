<template>
  <q-page padding>
    <div class="row items-center justify-between q-mb-lg">
      <div>
        <h1 class="text-h5 text-title-color text-weight-bold q-my-none">Trader Runtime</h1>
        <div class="text-caption text-grey-5 q-mt-xs">Standalone arbitration-trader</div>
      </div>

      <div class="row items-center q-gutter-sm">
        <q-btn flat round icon="refresh" color="grey-4" :loading="loading" @click="reload">
          <q-tooltip>Обновить runtime config</q-tooltip>
        </q-btn>
        <q-btn v-if="!runtimeConfig" color="primary" text-color="white" no-caps icon="add" label="Создать"
               @click="openCreateDialog"/>
      </div>
    </div>

    <div v-if="loading" class="text-center q-my-xl">
      <q-spinner color="primary" size="lg"/>
      <div class="text-grey-5 q-mt-md">Загрузка runtime config...</div>
    </div>

    <q-banner v-else-if="!runtimeConfig" dark class="bg-dark text-grey-4 q-pa-lg">
      Runtime config не создан.
      <template #action>
        <q-btn no-caps color="primary" label="Создать" @click="openCreateDialog"/>
      </template>
    </q-banner>

    <div v-else class="runtime-content">
      <q-card dark flat bordered class="bg-dark q-mb-md">
        <q-card-section class="row items-start justify-between q-col-gutter-md">
          <div class="col-12 col-md">
            <div class="row items-center q-gutter-sm q-mb-sm">
              <div class="text-h6 text-title-color">{{ runtimeConfig.name }}</div>
              <q-badge :color="runtimeConfig.is_active ? 'positive' : 'grey-7'"
                       :label="runtimeConfig.is_active ? 'ACTIVE' : 'STOPPED'"/>
            </div>
            <div class="text-caption text-grey-5 q-mb-xs">
              IP торгового сервера: <span class="text-white">{{ serverIpLabel }}</span>
            </div>
            <div class="text-caption text-grey-5">{{ runtimeConfig.service_url }}</div>
          </div>

          <div class="col-12 col-md-auto row q-gutter-sm">
            <q-btn
              v-if="!runtimeConfig.is_active"
              no-caps
              color="positive"
              icon="play_arrow"
              label="Start"
              :loading="saving"
              @click="startSelected"
            />
            <q-btn
              v-else
              no-caps
              color="warning"
              text-color="dark"
              icon="stop"
              label="Stop"
              :loading="saving"
              @click="stopSelected"
            />
            <q-btn no-caps outline color="primary" icon="sync" label="Sync" :disable="!runtimeConfig.is_active"
                   :loading="saving" @click="syncSelected"/>
            <q-btn
              no-caps
              outline
              color="secondary"
              icon="bolt"
              label="Speed XRPUSDT"
              :disable="runtimeConfig.is_active"
              :loading="testTradeLoading"
              @click="runTestTrade"
            >
              <q-tooltip v-if="runtimeConfig.is_active">Остановите runtime перед изолированной диагностической сделкой
              </q-tooltip>
            </q-btn>
            <q-btn flat round icon="edit" color="primary" @click="openEditDialog(runtimeConfig)">
              <q-tooltip>Редактировать</q-tooltip>
            </q-btn>
          </div>
        </q-card-section>

        <q-separator dark/>

        <q-card-section>
          <div class="row q-col-gutter-md">
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Статус</div>
              <div class="text-weight-bold">{{ runtimeConfig.status }}</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Sync</div>
              <div class="text-weight-bold" :class="runtimeConfig.sync_status === 'failed' ? 'text-negative' : ''">
                {{ runtimeConfig.sync_status }}
              </div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Сумма</div>
              <div class="text-weight-bold">{{ formatNumber(runtimeConfig.trade_amount_usdt) }} USDT</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Плечо</div>
              <div class="text-weight-bold">{{ runtimeConfig.leverage }}x</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Вход</div>
              <div class="text-weight-bold">{{ formatNumber(runtimeConfig.open_threshold) }}%</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Выход</div>
              <div class="text-weight-bold">{{ formatNumber(runtimeConfig.close_threshold) }}%</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Concurrent</div>
              <div class="text-weight-bold">{{ runtimeConfig.max_concurrent_trades }}</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Top 24h movers</div>
              <div class="text-weight-bold">{{ runtimeConfig.top_liquid_pairs_count }}</div>
            </div>
            <div class="col-6 col-md-3">
              <div class="text-caption text-grey-5">Environment</div>
              <div class="text-weight-bold" :class="runtimeConfig.use_testnet ? 'text-positive' : 'text-warning'">
                {{ runtimeConfig.use_testnet ? 'Testnet' : 'Live' }}
              </div>
            </div>
          </div>

          <q-banner v-if="runtimeConfig.last_sync_error" dense dark class="bg-negative q-mt-md">
            {{ runtimeConfig.last_sync_error }}
          </q-banner>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered class="bg-dark q-mb-md">
        <q-card-section class="row items-center justify-between">
          <div>
            <div class="text-h6 text-title-color">Speed probe XRPUSDT</div>
            <div class="text-caption text-grey-5">Изолированный open/close через Binance и Bybit в текущей среде</div>
          </div>
          <q-badge v-if="testTradeResult" :color="testTradeResult.success ? 'positive' : 'negative'"
                   :label="testTradeResult.success ? 'OK' : 'FAIL'"/>
        </q-card-section>

        <q-separator dark/>

        <q-card-section>
          <div v-if="testTradeResult" class="row q-col-gutter-md">
            <div class="col-6 col-md-2">
              <div class="text-caption text-grey-5">Amount</div>
              <div class="text-weight-bold">{{ formatNumber(testTradeResult.amount_usdt) }} USDT</div>
            </div>
            <div class="col-6 col-md-2">
              <div class="text-caption text-grey-5">Quantity</div>
              <div class="text-weight-bold">{{ formatNumber(testTradeResult.quantity) }}</div>
            </div>
            <div class="col-6 col-md-2">
              <div class="text-caption text-grey-5">Open total</div>
              <div class="text-weight-bold">{{ formatMs(testTradeResult.metrics.detection_to_open_finished_ms) }}</div>
            </div>
            <div class="col-6 col-md-2">
              <div class="text-caption text-grey-5">Close total</div>
              <div class="text-weight-bold">{{
                  formatMs(testTradeResult.metrics.close_submit_to_close_finished_ms)
                }}
              </div>
            </div>
            <div class="col-6 col-md-2">
              <div class="text-caption text-grey-5">Full cycle</div>
              <div class="text-weight-bold">{{ formatMs(testTradeResult.metrics.total_ms) }}</div>
            </div>
            <div class="col-12" v-if="testTradeResult.error">
              <q-banner dense dark class="bg-negative">{{ testTradeResult.error }}</q-banner>
            </div>
            <div class="col-12">
              <q-markup-table dark dense flat separator="horizontal">
                <thead>
                <tr>
                  <th class="text-left">Exchange</th>
                  <th class="text-right">Open ACK</th>
                  <th class="text-right">Open fill seen</th>
                  <th class="text-right">Close ACK</th>
                  <th class="text-right">Close fill seen</th>
                  <th class="text-right">Exchange total</th>
                </tr>
                </thead>
                <tbody>
                <tr v-for="row in testTradeRows" :key="row.exchange">
                  <td class="text-left">{{ exchangeLabel(row.exchange) }}</td>
                  <td class="text-right">{{ formatMs(row.open.submit_to_ack_ms) }}</td>
                  <td class="text-right">{{ formatMs(row.open.submit_to_fill_seen_ms) }}</td>
                  <td class="text-right">{{ formatMs(row.close.submit_to_ack_ms) }}</td>
                  <td class="text-right">{{ formatMs(row.close.submit_to_fill_seen_ms) }}</td>
                  <td class="text-right">{{ formatMs(row.exchange_total_ms) }}</td>
                </tr>
                </tbody>
              </q-markup-table>
            </div>
          </div>
          <div v-else class="text-grey-5">Тестовая сделка еще не запускалась</div>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered class="bg-dark q-mb-md">
        <q-card-section class="row items-center justify-between">
          <div class="text-h6 text-title-color">Диагностика</div>
          <div class="row q-gutter-sm">
            <q-btn no-caps outline color="primary" icon="memory" label="Runtime" :loading="diagnosticsLoading"
                   @click="refreshDiagnostics"/>
          </div>
        </q-card-section>

        <q-separator dark/>

        <q-card-section>
          <div class="row q-col-gutter-md">
            <div class="col-12 col-md-6">
              <q-card dark flat bordered class="bg-info full-height">
                <q-card-section>
                  <div class="text-subtitle2 text-title-color q-mb-sm">Exchange health</div>
                  <div v-if="exchangeHealth">
                    <div v-for="item in exchangeHealth.exchanges" :key="item.exchange"
                         class="row items-start justify-between q-mb-sm">
                      <div>
                        <div class="text-weight-bold">{{ exchangeLabel(item.exchange) }}</div>
                        <div v-if="item.error" class="text-caption text-negative">{{ item.error }}</div>
                      </div>
                      <q-badge :color="item.available ? 'positive' : 'negative'"
                               :label="item.available ? 'OK' : 'FAIL'"/>
                    </div>
                  </div>
                  <div v-else class="text-grey-5">Нет данных</div>
                </q-card-section>
              </q-card>
            </div>

            <div class="col-12 col-md-6">
              <q-card dark flat bordered class="bg-info full-height">
                <q-card-section>
                  <div class="text-subtitle2 text-title-color q-mb-sm">System load</div>
                  <div v-if="systemLoad">
                    <div class="row justify-between q-mb-xs">
                      <span class="text-grey-5">Runtime</span>
                      <span :class="systemLoad.risk_locked ? 'text-negative' : 'text-positive'">{{
                          systemLoad.runtime_state
                        }}</span>
                    </div>
                    <div class="row justify-between q-mb-xs">
                      <span class="text-grey-5">CPU</span>
                      <span>{{ systemLoad.cpu_percent }}%</span>
                    </div>
                    <q-linear-progress :value="systemLoad.cpu_percent / 100" color="primary" track-color="grey-9"
                                       class="q-mb-sm"/>
                    <div class="row justify-between q-mb-xs">
                      <span class="text-grey-5">Memory</span>
                      <span>{{ systemLoad.memory_used_percent }}%</span>
                    </div>
                    <q-linear-progress :value="systemLoad.memory_used_percent / 100" color="warning"
                                       track-color="grey-9"/>
                  </div>
                  <div v-else class="text-grey-5">Нет данных</div>
                </q-card-section>
              </q-card>
            </div>

            <div class="col-12">
              <q-card dark flat bordered class="bg-info">
                <q-card-section>
                  <div class="row items-center justify-between q-mb-sm">
                    <div class="text-subtitle2 text-title-color">Active coins</div>
                    <q-badge v-if="activeCoins" color="primary" :label="`${activeCoins.trade_count} trades`"/>
                  </div>
                  <div v-if="activeCoins?.active_coins.length" class="row q-gutter-xs">
                    <q-chip v-for="coin in activeCoins.active_coins" :key="coin" dense color="primary"
                            text-color="white">{{ coin }}
                    </q-chip>
                  </div>
                  <div v-else class="text-grey-5">Нет активных монет</div>
                </q-card-section>
              </q-card>
            </div>
          </div>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered class="bg-dark q-mb-md">
        <q-card-section class="row items-center justify-between">
          <div class="text-h6 text-title-color">Open trades PnL</div>
          <q-btn flat round icon="refresh" color="grey-4" @click="loadOpenTradesPnl">
            <q-tooltip>Обновить PnL</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-table
          flat
          dark
          dense
          :rows="openTradesPnl?.trades ?? []"
          :columns="pnlColumns"
          row-key="trade_id"
          :pagination="{ rowsPerPage: 10 }"
          no-data-label="Открытых сделок нет"
        />
      </q-card>

      <q-card dark flat bordered class="bg-dark q-mb-md">
        <q-card-section class="row items-center justify-between">
          <div class="text-h6 text-title-color">Real trades</div>
          <q-btn flat round icon="refresh" color="grey-4" @click="loadTrades">
            <q-tooltip>Обновить сделки</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-table
          flat
          dark
          dense
          :rows="trades"
          :columns="tradeColumns"
          row-key="id"
          :pagination="{ rowsPerPage: 10 }"
          no-data-label="Сделок нет"
        />
      </q-card>

      <q-card dark flat bordered class="bg-dark">
        <q-card-section class="row items-center justify-between">
          <div class="text-h6 text-title-color">Runtime errors</div>
          <q-btn flat round icon="refresh" color="grey-4" @click="loadErrors">
            <q-tooltip>Обновить ошибки</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-table
          flat
          dark
          dense
          :rows="errors"
          :columns="errorColumns"
          row-key="id"
          :pagination="{ rowsPerPage: 10 }"
          no-data-label="Ошибок нет"
        />
      </q-card>
    </div>

    <TraderRuntimeConfigDialog v-model="formOpen" :runtime-config="editingConfig" @saved="afterSaved"/>
  </q-page>
</template>

<script setup lang="ts">
import {computed, onMounted, ref} from 'vue';
import {storeToRefs} from 'pinia';
import {type QTableColumn, useQuasar} from 'quasar';
import TraderRuntimeConfigDialog from 'src/components/trader-runtime/TraderRuntimeConfigDialog.vue';
import {useTraderRuntimeStore} from 'src/stores/trader-runtime/traderRuntime.store';
import type {TraderRuntimeConfig} from 'src/stores/trader-runtime/api/traderRuntimeConfig';

const $q = useQuasar();
const store = useTraderRuntimeStore();
const {
  configs,
  loading,
  saving,
  diagnosticsLoading,
  testTradeLoading,
  exchangeHealth,
  activeCoins,
  openTradesPnl,
  systemLoad,
  serverInfo,
  testTradeResult,
  errors,
  trades,
} = storeToRefs(store);

const formOpen = ref(false);
const editingConfig = ref<TraderRuntimeConfig | null>(null);

const runtimeConfig = computed(() => {
  return configs.value[0] ?? null;
});

const serverIpLabel = computed(() => {
  if (!serverInfo.value) {
    return 'нет данных';
  }

  return serverInfo.value.server_ip || 'не найден';
});

const testTradeRows = computed(() => {
  const result = testTradeResult.value;
  if (!result) {
    return [];
  }

  return [result.metrics.binance, result.metrics.bybit];
});

const exchangeLabels: Record<string, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  gate: 'Gate',
  mexc: 'MEXC',
};

const pnlColumns: QTableColumn[] = [
  {name: 'trade_id', label: 'ID', field: 'trade_id', align: 'left', sortable: true},
  {name: 'coin', label: 'Coin', field: 'coin', align: 'left', sortable: true},
  {name: 'amount', label: 'Amount', field: 'amount', align: 'right', format: (value: number) => formatNumber(value)},
  {
    name: 'pnl',
    label: 'PnL %',
    field: 'estimated_pnl_percentage',
    align: 'right',
    format: (value: number | null) => formatNullablePercent(value)
  },
  {
    name: 'pnl_usdt',
    label: 'PnL USDT',
    field: 'estimated_pnl_usdt',
    align: 'right',
    format: (value: number | null) => formatNullableNumber(value)
  },
  {name: 'pricing_mode', label: 'Mode', field: 'pricing_mode', align: 'left'},
];

const tradeColumns: QTableColumn[] = [
  {name: 'id', label: 'ID', field: 'id', align: 'left', sortable: true},
  {name: 'coin', label: 'Coin', field: 'coin', align: 'left', sortable: true},
  {name: 'status', label: 'Status', field: 'status', align: 'left'},
  {name: 'amount', label: 'Amount', field: 'amount', align: 'right', format: (value: string) => formatNumber(value)},
  {
    name: 'open_spread',
    label: 'Open %',
    field: 'open_spread',
    align: 'right',
    format: (value: string) => `${formatNumber(value)}%`
  },
  {
    name: 'profit_usdt',
    label: 'Profit USDT',
    field: 'profit_usdt',
    align: 'right',
    format: (value: string | null) => formatNullableNumber(value)
  },
  {
    name: 'profit_percentage',
    label: 'Profit %',
    field: 'profit_percentage',
    align: 'right',
    format: (value: string | null) => formatNullablePercent(value)
  },
  {name: 'opened_at', label: 'Opened', field: 'opened_at', align: 'left', format: formatDateTime},
];

const errorColumns: QTableColumn[] = [
  {name: 'created_at', label: 'Created', field: 'created_at', align: 'left', format: formatDateTime, sortable: true},
  {name: 'error_type', label: 'Type', field: 'error_type', align: 'left', sortable: true},
  {name: 'error_text', label: 'Text', field: 'error_text', align: 'left'},
];

function exchangeLabel(exchange: string) {
  return exchangeLabels[exchange] ?? exchange;
}

function formatNumber(value: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 8}).format(numeric);
}

function formatNullableNumber(value: string | number | null) {
  return value === null ? '-' : formatNumber(value);
}

function formatNullablePercent(value: string | number | null) {
  return value === null ? '-' : `${formatNumber(value)}%`;
}

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) {
    return '-';
  }

  return `${Math.round(Number(value))} ms`;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

async function reload() {
  await store.fetchConfigs();
  if (runtimeConfig.value) {
    await loadRelatedData(runtimeConfig.value.id);
  } else {
    store.clearRuntimeData();
  }
}

async function loadRelatedData(id: number) {
  await Promise.allSettled([
    store.fetchServerInfo(id),
    store.fetchErrors(id),
    store.fetchTrades(id),
  ]);
}

function openCreateDialog() {
  editingConfig.value = null;
  formOpen.value = true;
}

function openEditDialog(config: TraderRuntimeConfig) {
  editingConfig.value = config;
  formOpen.value = true;
}

async function afterSaved() {
  await reload();
}

async function startSelected() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  $q.dialog({
    title: 'Запустить runtime',
    message: 'Отправить runtime config в standalone trader?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'positive',
  }).onOk(async () => {
    try {
      await store.startConfig(config.id);
      $q.notify({color: 'positive', message: 'Команда start отправлена'});
    } catch (error) {
      console.error(error);
      $q.notify({color: 'negative', message: 'Не удалось запустить runtime'});
    }
  });
}

async function stopSelected() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  $q.dialog({
    title: 'Остановить runtime',
    message: 'Отправить stop в standalone trader?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'warning',
  }).onOk(async () => {
    try {
      await store.stopConfig(config.id);
      $q.notify({color: 'positive', message: 'Команда stop отправлена'});
    } catch (error) {
      console.error(error);
      $q.notify({color: 'negative', message: 'Не удалось остановить runtime'});
    }
  });
}

async function syncSelected() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  try {
    await store.syncConfig(config.id);
    $q.notify({color: 'positive', message: 'Команда sync отправлена'});
  } catch (error) {
    console.error(error);
    $q.notify({color: 'negative', message: 'Не удалось синхронизировать runtime'});
  }
}

async function runTestTrade() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  $q.dialog({
    title: 'Диагностическая сделка XRPUSDT',
    message: config.use_testnet
      ? 'Открыть и сразу закрыть testnet-сделку на Binance и Bybit? Runtime должен быть остановлен.'
      : 'Открыть и сразу закрыть LIVE-сделку на Binance и Bybit реальными market orders? Runtime должен быть остановлен.',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'secondary',
  }).onOk(async () => {
    try {
      await store.runTestTrade(config.id);
      $q.notify({color: 'positive', message: 'Диагностическая сделка выполнена'});
    } catch (error) {
      console.error(error);
      $q.notify({color: 'negative', message: 'Не удалось выполнить диагностическую сделку'});
    }
  });
}

async function refreshDiagnostics() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  try {
    await store.refreshDiagnostics(config.id);
  } catch (error) {
    console.error(error);
    $q.notify({color: 'negative', message: 'Не удалось получить диагностику runtime'});
    await store.fetchErrors(config.id).catch(() => undefined);
  }
}

async function loadOpenTradesPnl() {
  const config = runtimeConfig.value;
  if (!config) {
    return;
  }

  try {
    await store.fetchOpenTradesPnl(config.id);
  } catch (error) {
    console.error(error);
    $q.notify({color: 'negative', message: 'Не удалось обновить PnL'});
  }
}

async function loadTrades() {
  const config = runtimeConfig.value;
  if (config) {
    await store.fetchTrades(config.id);
  }
}

async function loadErrors() {
  const config = runtimeConfig.value;
  if (config) {
    await store.fetchErrors(config.id);
  }
}

onMounted(() => {
  void reload();
});
</script>

<template>
  <q-page class="q-pa-md text-white column no-wrap">
    <div class="row items-center q-gutter-x-sm q-mb-md">
      <q-btn flat dense round icon="arrow_back" color="grey-5" @click="goBack">
        <q-tooltip>Назад к скринеру</q-tooltip>
      </q-btn>
      <h4 class="q-my-none text-h6 text-weight-bold">{{ symbol }}</h4>

      <q-space />

      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="analytics"
        label="Анализ"
        :loading="analysis.running"
        @click="dialogOpen = true"
      />
    </div>

    <!-- Timeframe switch for the top levels chart. Each switch refetches the coin
         on that timeframe (levels are computed per-timeframe), so the chart and its
         level rays follow the chosen timeframe. -->
    <div v-if="store.timeframes.length" class="row items-center no-wrap q-gutter-x-xs q-mb-sm">
      <q-btn
        v-for="tf in store.timeframes"
        :key="tf"
        :label="tf"
        no-caps
        dense
        unelevated
        :color="tf === chartTf ? 'primary' : 'dark'"
        :text-color="tf === chartTf ? 'white' : 'grey-5'"
        class="ctrl-btn"
        :disable="chartLoading"
        @click="onTopTimeframe(tf)"
      />
    </div>

    <!-- Small levels chart computed with the params carried in the URL (from the
         alert link or the screener filters). Falls back to defaults if absent. -->
    <div class="levels-chart-box q-mb-md">
      <LevelChartCard v-if="chartEntry" :entry="chartEntry" :timeframe="chartTf" />
      <div v-else-if="chartLoading" class="full-height flex flex-center">
        <q-spinner color="primary" size="md" />
      </div>
      <div v-else class="full-height flex flex-center text-grey-6 text-caption">
        {{ chartError || 'Нет данных по уровням' }}
      </div>
    </div>

    <q-banner v-if="analysis.error" dense class="bg-negative text-white q-mb-md rounded-borders">
      {{ analysis.error }}
    </q-banner>

    <div class="text-caption text-grey-5 q-mb-xs">Анализы</div>
    <LevelsAnalysisList
      class="q-mb-md"
      :items="analysis.items"
      :loading="analysis.listLoading"
      :selected-id="analysis.selected?.id ?? null"
      @select="onSelect"
    />

    <div class="col column no-wrap">
      <div v-if="analysis.detailLoading" class="flex flex-center q-pa-xl">
        <q-spinner color="primary" size="lg" />
      </div>
      <LevelsAnalysisResults
        v-else-if="analysis.selected"
        :result="analysis.selected"
        :loading="false"
        :error="null"
      />
      <div v-else class="text-center text-grey-5 q-pa-xl">
        Выберите анализ из списка или запустите новый кнопкой «Анализ»
      </div>
    </div>

    <LevelsAnalysisDialog
      v-model="dialogOpen"
      :settings="settings"
      :timeframes="store.timeframes"
      :loading="analysis.running"
      @run="onRun"
    />
  </q-page>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  useLevelsStore,
  LEVELS_DEFAULT_NATR_MULTIPLIER,
  LEVELS_DEFAULT_MIN_GAP,
} from 'src/stores/levels/levels.store';
import {
  useAnalysisStore,
  ANALYSIS_DEFAULTS,
  type AnalysisSettings,
} from 'src/stores/levels/analysis.store';
import { levelsApi, type ScreenerEntry } from 'src/stores/levels/api/levelsApi';
import { usePriceNotificationsStore } from 'src/stores/levels/priceNotifications.store';
import LevelChartCard from 'src/components/levels/LevelChartCard.vue';
import LevelsAnalysisDialog from 'src/components/levels/LevelsAnalysisDialog.vue';
import LevelsAnalysisResults from 'src/components/levels/LevelsAnalysisResults.vue';
import LevelsAnalysisList from 'src/components/levels/LevelsAnalysisList.vue';

const route = useRoute();
const router = useRouter();
const store = useLevelsStore();
const analysis = useAnalysisStore();

// Price alerts for the dashed rays the chart overlays. Loaded once on mount;
// the chart card reads them from the store per symbol.
const priceNotificationsStore = usePriceNotificationsStore();
if (!priceNotificationsStore.loaded) void priceNotificationsStore.load();

const symbol = computed(() => String(route.params.symbol ?? '').toUpperCase());

const dialogOpen = ref(false);

// Top levels chart: the single coin computed with the params carried in the URL
// (natrMultiplier/minGap from the alert link or the screener filters), so it shows
// the same levels the alert/screener used. minVolume is a universe pre-filter, so
// it is forced to 0 here — never filter out the very coin being viewed.
const chartEntry = ref<ScreenerEntry | null>(null);
const chartTf = ref('1h');
const chartLoading = ref(false);
const chartError = ref('');

// Positive numeric query param or fallback (query values are string | string[]).
function numQuery(key: string, fallback: number): number {
  const raw = route.query[key];
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function loadChart(timeframe: string): Promise<void> {
  chartLoading.value = true;
  chartError.value = '';
  chartEntry.value = null;
  // Reflect the requested timeframe in the TF-button highlight immediately (before
  // the request resolves) and keep it correct even if the load fails.
  chartTf.value = timeframe;
  const natrMultiplier = numQuery('natrMultiplier', store.natrMultiplier || LEVELS_DEFAULT_NATR_MULTIPLIER);
  const minGap = numQuery('minGap', store.minGap || LEVELS_DEFAULT_MIN_GAP);
  try {
    const page = await levelsApi.screener(timeframe, {
      search: symbol.value,
      natrMultiplier,
      minGap,
      minVolume: 0,
      limit: 20,
    });
    const found = page.items.find((item) => item.symbol === symbol.value) ?? null;
    chartEntry.value = found;
    if (!found) chartError.value = 'Нет данных по уровням';
  } catch {
    chartError.value = 'Не удалось загрузить график';
  } finally {
    chartLoading.value = false;
  }
}

// Switch the top chart timeframe. Reloads the coin on that timeframe (loadChart
// recomputes levels per-timeframe), which remounts LevelChartCard cleanly with the
// new entry + timeframe. Guarded against re-selecting the current one / concurrent
// loads.
function onTopTimeframe(timeframe: string): void {
  if (timeframe === chartTf.value || chartLoading.value) return;
  void loadChart(timeframe);
}

// Analysis settings (the dialog form), persisted across reloads except the
// timeframe, which defaults to the screener's current timeframe.
const SETTINGS_KEY = 'levels.analysisSettings';
const settings = reactive<AnalysisSettings>({
  timeframe: '',
  ...ANALYSIS_DEFAULTS,
  ...loadSettings(),
});

function loadSettings(): Partial<AnalysisSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<AnalysisSettings>;
    delete parsed.timeframe;
    return parsed;
  } catch {
    return {};
  }
}

function persistSettings() {
  const { timeframe: _omit, ...rest } = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
}

function onSelect(id: number) {
  void analysis.select(id);
}

function onRun(next: AnalysisSettings) {
  Object.assign(settings, next);
  persistSettings();
  void analysis.run(symbol.value, { ...settings }).catch(() => {
    /* error surfaced via analysis.error */
  });
}

function goBack() {
  if (window.history.length > 1) router.back();
  else void router.push('/levels');
}

async function init() {
  if (!store.timeframes.length) {
    try {
      await store.fetchTimeframes();
    } catch {
      /* timeframe select falls back to the persisted/default value */
    }
  }
  const queryTf = typeof route.query.tf === 'string' ? route.query.tf : '';
  settings.timeframe =
    (queryTf && store.timeframes.includes(queryTf) ? queryTf : '') ||
    store.timeframe ||
    store.timeframes[0] ||
    '1h';
  // Load the top chart in parallel — it must not block the analysis list.
  void loadChart(settings.timeframe);
  await analysis.fetchList(symbol.value);
}

// Re-init when navigating between coins (same component, route param changes).
watch(symbol, init, { immediate: true });
</script>

<style lang="sass" scoped>
.ctrl-btn
  min-width: 40px
  border-radius: 6px

// Fixed-height box for the top levels chart (LevelChartCard is height:100%).
.levels-chart-box
  height: 420px
  flex: none

@media (max-width: 599.98px)
  .levels-chart-box
    height: 300px
</style>

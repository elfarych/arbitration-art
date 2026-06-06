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
import { useLevelsStore } from 'src/stores/levels/levels.store';
import {
  useAnalysisStore,
  ANALYSIS_DEFAULTS,
  type AnalysisSettings,
} from 'src/stores/levels/analysis.store';
import LevelsAnalysisDialog from 'src/components/levels/LevelsAnalysisDialog.vue';
import LevelsAnalysisResults from 'src/components/levels/LevelsAnalysisResults.vue';
import LevelsAnalysisList from 'src/components/levels/LevelsAnalysisList.vue';

const route = useRoute();
const router = useRouter();
const store = useLevelsStore();
const analysis = useAnalysisStore();

const symbol = computed(() => String(route.params.symbol ?? '').toUpperCase());

const dialogOpen = ref(false);

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
  await analysis.fetchList(symbol.value);
}

// Re-init when navigating between coins (same component, route param changes).
watch(symbol, init, { immediate: true });
</script>

<style lang="sass" scoped>
.ctrl-btn
  min-width: 40px
  border-radius: 6px
</style>

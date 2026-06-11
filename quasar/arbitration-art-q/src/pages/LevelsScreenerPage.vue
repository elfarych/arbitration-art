<template>
  <q-page class="q-pa-md text-white column no-wrap">
    <div class="row items-center q-gutter-x-sm q-mb-sm header-row">
      <label class="search-field row no-wrap items-center">
        <q-icon name="search" size="18px" class="text-grey-5" />
        <input
          v-model="searchInput"
          type="text"
          placeholder="Поиск монеты"
          class="search-input-native"
          @input="onSearchInput"
          @keyup.enter="commitSearch"
        />
        <q-icon
          v-if="searchInput"
          name="close"
          size="16px"
          class="search-clear text-grey-5 cursor-pointer"
          @click="clearSearch"
        />
      </label>

      <q-space />

      <div class="row items-center no-wrap q-gutter-x-xs">
        <q-btn
          v-for="tf in store.timeframes"
          :key="tf"
          :label="tf"
          no-caps
          dense
          unelevated
          :color="tf === store.timeframe ? 'primary' : 'dark'"
          :text-color="tf === store.timeframe ? 'white' : 'grey-5'"
          class="ctrl-btn"
          @click="onTimeframe(tf)"
        />
      </div>

      <div v-if="store.pageCount > 1" class="row items-center no-wrap q-gutter-x-xs">
        <q-btn
          flat
          dense
          round
          icon="first_page"
          color="grey-5"
          :disable="store.page <= 1"
          @click="onPage(1)"
        >
          <q-tooltip>На первую страницу</q-tooltip>
        </q-btn>
        <q-btn
          flat
          dense
          round
          icon="chevron_left"
          color="grey-5"
          :disable="store.page <= 1"
          @click="onPage(store.page - 1)"
        >
          <q-tooltip>Назад</q-tooltip>
        </q-btn>
        <span class="text-grey-4 text-weight-medium q-px-xs">{{ store.page }}</span>
        <q-btn
          flat
          dense
          round
          icon="chevron_right"
          color="grey-5"
          :disable="store.page >= store.pageCount"
          @click="onPage(store.page + 1)"
        >
          <q-tooltip>Вперёд</q-tooltip>
        </q-btn>
      </div>

      <LevelsFilters
        :min-volume="store.minVolume"
        :natr-multiplier="store.natrMultiplier"
        :min-gap="store.minGap"
        :pin-favorites="store.pinFavorites"
        :favorites-count="favoritesStore.count"
        :timeframe="store.timeframe"
        @apply="onParams"
        @toggle-pin="onTogglePin"
      />

      <LevelsGridPicker :columns="columns" :rows="rows" :max="5" @select="onSelectGrid" />

      <q-btn
        unelevated
        dense
        no-caps
        color="dark"
        text-color="grey-5"
        icon="refresh"
        class="ctrl-btn"
        :loading="store.loading"
        @click="store.fetchScreener()"
      >
        <q-tooltip>Обновить</q-tooltip>
      </q-btn>

      <q-btn
        unelevated
        dense
        no-caps
        icon="notifications"
        class="ctrl-btn"
        :color="notificationsStore.config.enabled ? 'primary' : 'dark'"
        :text-color="notificationsStore.config.enabled ? 'white' : 'grey-5'"
        @click="showNotifications = true"
      >
        <q-tooltip>Настройки уведомлений</q-tooltip>
      </q-btn>
    </div>

    <q-banner v-if="store.error" dense class="bg-negative text-white q-mb-md rounded-borders">
      {{ store.error }}
    </q-banner>

    <div v-if="store.loading && !store.entries.length" class="flex flex-center q-pa-xl">
      <q-spinner color="primary" size="lg" />
    </div>

    <div v-else-if="!store.entries.length" class="text-center text-grey-5 q-pa-xl">
      {{ store.search ? `Ничего не найдено по запросу «${store.search}»` : 'Нет данных по выбранному таймфрейму' }}
    </div>

    <div v-else class="levels-grid" :style="{ '--cols': columns, '--rows': rows }">
      <LevelChartCard
        v-for="entry in store.entries"
        :key="entry.symbol"
        :entry="entry"
        :timeframe="store.timeframe"
        @open="onOpenCoin"
      />
    </div>

    <LevelsNotificationsDialog v-model="showNotifications" />
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useLevelsStore, LEVELS_MIN_VOLUME } from 'src/stores/levels/levels.store';
import { useFavoritesStore } from 'src/stores/levels/favorites.store';
import { useNotificationsStore } from 'src/stores/levels/notifications.store';
import { usePriceNotificationsStore } from 'src/stores/levels/priceNotifications.store';
import LevelChartCard from 'src/components/levels/LevelChartCard.vue';
import LevelsGridPicker from 'src/components/levels/LevelsGridPicker.vue';
import LevelsFilters from 'src/components/levels/LevelsFilters.vue';
import LevelsNotificationsDialog from 'src/components/levels/LevelsNotificationsDialog.vue';

const store = useLevelsStore();
const favoritesStore = useFavoritesStore();
const notificationsStore = useNotificationsStore();
const priceNotificationsStore = usePriceNotificationsStore();
const router = useRouter();

// Notification settings dialog (per-user level alerts).
const showNotifications = ref(false);

// Open the coin detail page; carry the current screener timeframe and the level
// params from the filters so the detail page renders a chart with the same levels
// the user is looking at. minVolume is a universe pre-filter (irrelevant to a
// single coin), so it is not passed.
function onOpenCoin(symbol: string) {
  void router.push({
    path: `/levels/${symbol}`,
    query: {
      tf: store.timeframe,
      natrMultiplier: String(store.natrMultiplier),
      minGap: String(store.minGap),
    },
  });
}

// Grid layout: columns × rows, chosen via the dropdown picker (max 5×5) and
// persisted so the choice sticks. Page size = columns × rows.
const GRID_MAX = 5;
const GRID_COLS_KEY = 'levels.gridColumns';
const GRID_ROWS_KEY = 'levels.gridRows';

function loadAxis(key: string, fallback: number): number {
  const stored = Number(localStorage.getItem(key));
  return Number.isInteger(stored) && stored >= 1 && stored <= GRID_MAX ? stored : fallback;
}
const columns = ref<number>(loadAxis(GRID_COLS_KEY, 2));
const rows = ref<number>(loadAxis(GRID_ROWS_KEY, 3));

async function onSelectGrid({ columns: c, rows: r }: { columns: number; rows: number }) {
  columns.value = c;
  rows.value = r;
  localStorage.setItem(GRID_COLS_KEY, String(c));
  localStorage.setItem(GRID_ROWS_KEY, String(r));
  await store.setPageSize(c * r);
}

// Calculation params (volume / NATR tolerance / touch gap) are held in the store
// and persisted so the choice sticks across reloads.
const PARAM_MIN_VOLUME_KEY = 'levels.minVolume';
const PARAM_NATR_MULT_KEY = 'levels.natrMultiplier';
const PARAM_MIN_GAP_KEY = 'levels.minGap';
const PIN_FAVORITES_KEY = 'levels.pinFavorites';

function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function onParams(p: { minVolume: number; natrMultiplier: number; minGap: number }) {
  localStorage.setItem(PARAM_MIN_VOLUME_KEY, String(p.minVolume));
  localStorage.setItem(PARAM_NATR_MULT_KEY, String(p.natrMultiplier));
  localStorage.setItem(PARAM_MIN_GAP_KEY, String(p.minGap));
  await store.setParams(p);
}

// Toggle "pin favorites to the top"; persist the choice so it sticks across
// reloads. The store reshapes the fetch (full universe vs one page) accordingly.
async function onTogglePin() {
  const next = !store.pinFavorites;
  localStorage.setItem(PIN_FAVORITES_KEY, next ? '1' : '0');
  await store.setPinFavorites(next);
}

// Symbol search. Local input mirrors the LevelsFilters pills (native input in a
// styled label). Debounced by 350ms so a recompute fires once the user pauses,
// not per keystroke; Enter commits immediately, the clear icon resets it.
const searchInput = ref(store.search);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function commitSearch() {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  void store.setSearch(searchInput.value);
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(commitSearch, 350);
}

function clearSearch() {
  searchInput.value = '';
  commitSearch();
}

async function onTimeframe(timeframe: string) {
  await store.setTimeframe(timeframe);
}

async function onPage(page: number) {
  await store.setPage(page);
}

onMounted(async () => {
  // Apply the persisted grid size and calculation params before the first fetch
  // so the page loads the right charts and screen immediately. Data refreshes
  // only on manual action (refresh button, timeframe/grid/page/param change) —
  // no background polling.
  store.pageSize = columns.value * rows.value;
  // Clamp the persisted value up to the floor so users with an old localStorage
  // entry (0 = off, or a sub-20M value) still respect the 20M minimum.
  store.minVolume = Math.max(LEVELS_MIN_VOLUME, loadNumber(PARAM_MIN_VOLUME_KEY, store.minVolume));
  store.natrMultiplier = loadNumber(PARAM_NATR_MULT_KEY, store.natrMultiplier);
  store.minGap = loadNumber(PARAM_MIN_GAP_KEY, store.minGap);
  store.pinFavorites = localStorage.getItem(PIN_FAVORITES_KEY) === '1';
  // Favorites must be loaded before the first screener fetch so pinned ordering
  // and filled stars are correct on first paint. Loaded alongside timeframes.
  // Notification config is loaded in parallel — it only feeds the bell button's
  // active state and the dialog, so it does not gate the first paint.
  void notificationsStore.load();
  // Price alerts feed the dashed rays the chart cards overlay; load in parallel.
  void priceNotificationsStore.load();
  await Promise.all([favoritesStore.load(), store.fetchTimeframes()]);
  await store.fetchScreener();
});
</script>

<style lang="sass" scoped>
// Uniform header control buttons (timeframe + refresh): even width, modest
// radius — a clean restrained set, not chunky pills or round icons.
.ctrl-btn
  min-width: 40px
  border-radius: 6px

// Symbol search pill — mirrors LevelsFilters `.filter-field` (dark fill, 6px
// radius, 32px height, primary focus ring) so the header reads as one control
// group. Native input instead of q-input to guarantee the exact same look.
.search-field
  height: 32px
  width: 180px
  padding: 0 10px
  background: $dark
  border-radius: 6px
  cursor: text
  transition: box-shadow 0.1s ease
  &:focus-within
    box-shadow: inset 0 0 0 1px $primary

.search-input-native
  flex: 1 1 auto
  width: 100%
  min-width: 0
  margin: 0 6px
  border: none
  outline: none
  background: transparent
  color: $title-color
  font-size: 13px
  font-weight: 600
  &::placeholder
    color: $grey-6
    font-weight: 400

.search-clear
  flex: none

// Fill the remaining viewport height so all rows fit without page scroll;
// min-height:0 lets the grid shrink instead of overflowing the flex column.
.levels-grid
  flex: 1 1 0
  min-height: 0
  display: grid
  grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr))
  grid-template-rows: repeat(var(--rows, 3), minmax(0, 1fr))
  gap: 8px

// On phones a viewport-fit grid of N rows is unusable: fall back to a single
// scrollable column with a sane fixed row height.
@media (max-width: 599.98px)
  .levels-grid
    flex: none
    grid-template-columns: minmax(0, 1fr)
    grid-template-rows: none
    grid-auto-rows: 280px
</style>

# Arbitration Art Quasar App - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние Quasar/Vue frontend проекта `quasar/arbitration-art-q`: архитектуру, маршруты, экраны, Pinia stores, boot-файлы, API-интеграции, WebSocket-слой бирж, стили, команды запуска и технические риски.

## 1. Краткое резюме

`arbitration-art-q` - Quasar Framework 2 + Vue 3 + TypeScript frontend для Arbitration Art.

Главные функции приложения:

- Login через Django JWT API; auth hydration в router guard (см. §8.2).
- Защищенная область приложения после авторизации.
- Список пользовательских bot configs с periodic refresh для engine sync_status / last_sync_error.
- Создание, редактирование, активация/деактивация и удаление ботов через Django ViewSet. Frontend нормализует `coin` в ccxt-формат и блокирует restricted-fields пока бот активен (см. §17).
- Force-close команда для bot-engine через Django.
- Отдельный раздел управления standalone `TraderRuntimeConfig` для `arbitration-trader`.
- Создание, редактирование, запуск/остановка/синхронизация и архивирование runtime config standalone trader.
- Диагностика standalone trader через Django proxy: exchange health, active coins, open trades PnL, system load.
- Просмотр runtime errors и real trades, связанных с `TraderRuntimeConfig`.
- Live-карточки ботов со spread monitoring по стаканам бирж (только для отображения).
- Просмотр истории emulation и real trades — engine пишет их в Django, frontend только читает через polling (5s) с фильтром `bot_id` + `status`.
- Просмотр исторического графика spread через `lightweight-charts`.
- Отдельный screener spread по выбранной паре бирж и направлению.

**Trade-логика** (открытие/закрытие сделок) принадлежит `arbitration-bot-engine`. Frontend никогда не пишет в `/bots/trades/` или `/bots/real-trades/`, только читает. Это устраняет двойные записи и зависимость торгового цикла от открытой вкладки.

Frontend работает с двумя типами источников данных:

- Django backend API через `/api` base URL в `boot/axios.ts`.
- Биржевые public REST/WebSocket API напрямую из браузера через devServer proxy и native `WebSocket`.

## 2. Технологический стек

Фактические зависимости из `package.json`:

- Quasar `^2.16.0`
- `@quasar/app-vite`
- Vue `^3.5.22`
- Vue Router `^5.0.3`
- Pinia `^3.0.1`
- Axios `^1.13.6`
- Vue I18n `^11.3.0`
- `@intlify/unplugin-vue-i18n`
- `lightweight-charts` `^5.1.0`
- TypeScript `^5.9.3`

Package manager:

- Проект содержит `pnpm-lock.yaml`.
- `package.json` требует `pnpm >= 9`.

Node engine:

```json
"node": "^28 || ^26 || ^24 || ^22.12"
```

## 3. Скрипты

`package.json`:

```json
{
  "dev": "quasar dev",
  "build": "quasar build",
  "postinstall": "quasar prepare",
  "test": "echo \"No test specified\" && exit 0"
}
```

Команды:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/quasar/arbitration-art-q
pnpm install
pnpm dev
pnpm build
pnpm test
```

`pnpm test` не запускает реальные тесты, только печатает `No test specified` и завершается с `0`.

## 4. Структура проекта

```text
quasar/arbitration-art-q/
├── package.json
├── pnpm-lock.yaml
├── quasar.config.ts
├── tsconfig.json
├── index.html
├── README.md
├── DOCS.md
├── public/
│   └── icons/
└── src/
    ├── App.vue
    ├── boot/
    │   ├── axios.ts
    │   └── i18n.ts
    ├── css/
    │   ├── app.sass
    │   └── quasar.variables.sass
    ├── i18n/
    │   ├── index.ts
    │   └── en-US/index.ts
    ├── layouts/
    │   ├── MainLayout.vue
    │   └── AuthLayout.vue
    ├── pages/
    │   ├── IndexPage.vue
    │   ├── TraderRuntimePage.vue
    │   ├── ProfilePage.vue
    │   ├── ScreenerPage.vue
    │   ├── ErrorNotFound.vue
    │   └── auth/LoginPage.vue
    ├── router/
    │   ├── index.ts
    │   └── routes.ts
    ├── stores/
    │   ├── index.ts
    │   ├── auth.ts
    │   ├── bots/
    │   ├── profile/
    │   ├── trader-runtime/
    │   ├── exchanges/
    │   └── screener/
    └── components/
        ├── bots/
        └── trader-runtime/
```

## 5. Quasar config

Файл: `quasar.config.ts`.

### 5.1. Boot files

```ts
boot: [
  'i18n',
  'axios'
]
```

Порядок важен:

- `i18n` подключает Vue I18n.
- `axios` создает `$axios`, `$api` и interceptors.

### 5.2. CSS

```ts
css: ['app.sass']
```

Глобальные Sass variables доступны из `src/css/quasar.variables.sass`.

### 5.3. Extras

Подключены:

- `roboto-font`
- `material-icons`

### 5.4. Build

```ts
target: {
  browser: 'baseline-widely-available',
  node: 'node22'
}
```

TypeScript:

```ts
typescript: {
  strict: true,
  vueShim: true
}
```

Router mode:

```ts
vueRouterMode: 'hash'
```

Значит URL работает через hash history, например:

```text
/#/
/#/login
/#/screener
```

### 5.5. Vite plugins

Используется:

```ts
@intlify/unplugin-vue-i18n/vite
```

i18n resources включены из:

```text
src/i18n
```

### 5.6. Dev server proxy

В dev mode настроены proxy:

| Frontend prefix | Target |
|---|---|
| `/binance-api` | `https://fapi.binance.com` |
| `/binance-spot-api` | `https://api.binance.com` |
| `/mexc-api` | `https://contract.mexc.com` |
| `/bybit-api` | `https://api.bybit.com` |

Эти proxy используются REST-клиентами бирж в `src/stores/exchanges/api/*`.

Важно:

- Proxy работает только в Quasar dev server.
- В production build эти пути должны быть обеспечены reverse proxy, backend proxy или другой инфраструктурой.
- WebSocket подключения к биржам идут напрямую и devServer proxy не используют.

### 5.7. Quasar plugins

Подключены:

- `Notify`
- `Dialog`

Использование:

- `IndexPage.vue` показывает confirm dialogs и notifications.
- `BotFormDialog.vue` показывает success/error notifications.
- `BotCard.vue` показывает inline popup edit и notifications при autosave.

## 6. TypeScript

`tsconfig.json`:

```json
{
  "extends": "./.quasar/tsconfig.json"
}
```

Quasar генерирует `.quasar/tsconfig.json` во время `quasar prepare` / `postinstall`.

Практический вывод:

- После fresh install нужен `pnpm install` или `pnpm exec quasar prepare`.
- Без `.quasar` IDE/typecheck могут работать некорректно.

## 7. Root App

Файл: `src/App.vue`.

Минимальный root:

```vue
<router-view />
```

Вся структура экранов определяется router layout-ами.

## 8. Routing и auth guard

### 8.1. Routes

Файл: `src/router/routes.ts`.

Routes:

| Path | Layout | Page | Назначение |
|---|---|---|---|
| `/login` | `AuthLayout` | `LoginPage` | Авторизация |
| `/` | `MainLayout` | `IndexPage` | Мои боты |
| `/trader-runtime` | `MainLayout` | `TraderRuntimePage` | Standalone trader runtime |
| `/profile` | `MainLayout` | `ProfilePage` | Профиль и API-ключи бирж |
| `/screener` | `MainLayout` | `ScreenerPage` | Скринер спредов |
| `/:catchAll(.*)*` | none | `ErrorNotFound` | 404 |

`/` route имеет:

```ts
meta: { requiresAuth: true }
```

Но guard сейчас не читает `meta.requiresAuth`; он проверяет path напрямую.

### 8.2. Router guard

Файл: `src/router/index.ts`.

Async guard выполняет hydration `currentUser` до пропуска навигации:

```ts
const hasAccessToken = !!authStore.accessToken || !!localStorage.getItem('access_token');
if (hasAccessToken && !authStore.currentUser) {
  try { await authStore.fetchUser(); } catch { /* axios interceptor чистит сессию */ }
}
const isAuthenticated = !!authStore.currentUser;
```

Behavior:

- Если есть access token, но user не загружен (cold start / F5), guard выполнит `fetchUser` перед резолвом маршрута. Это устраняет окно «route считает юзера залогиненным, а `currentUser=null` в компонентах».
- Если `fetchUser` упал (401, axios interceptor → `clearSession()` + redirect /login), guard видит `currentUser=null` и перенаправляет на `/login`.
- Если route не `/login` и `currentUser=null` → redirect `/login`.
- Если route `/login` и `currentUser` есть → redirect `/`.

`MainLayout` больше не вызывает `fetchUser` в `onMounted` — guard гарантирует, что к моменту рендера user уже загружен (или guard отработал redirect). `loadingUser` в MainLayout остался как computed `!authStore.currentUser` для очень коротких переходов после login.

## 9. Boot: Axios

Файл: `src/boot/axios.ts`.

Создается:

```ts
const api = axios.create({ baseURL: process.env.API_URL });
```

Инжектится в Vue:

```ts
app.config.globalProperties.$axios = axios;
app.config.globalProperties.$api = api;
```

Также экспортируется:

```ts
export { api };
```

### 9.1. Request interceptor

Перед каждым request:

- читает `access_token` из `localStorage`;
- если token есть, ставит:

```text
Authorization: Bearer <token>
```

### 9.2. Response interceptor

На `401`:

1. Если сам запрос был `/auth/refresh/`:
   - clear session;
   - router push `/login`;
   - reject.
2. Если refresh уже выполняется:
   - поставить запрос в `failedQueue`;
   - дождаться refresh;
   - повторить original request.
3. Если refresh еще не выполняется:
   - пометить `_retry`;
   - вызвать `authStore.refreshTokenCall()`;
   - обновить queued requests;
   - повторить original request.
4. Если refresh failed:
   - reject queued requests;
   - clear session;
   - router push `/login`.

Плюсы:

- предотвращает одновременный refresh storm.
- повторяет запросы после refresh.

Риски:

- `_retry` используется на Axios request config без расширенного типа.
- `originalRequest.url.includes(...)` может упасть, если `url` undefined.
- Tokens хранятся в `localStorage`, что уязвимо при XSS.

## 10. Boot: i18n

Файл: `src/boot/i18n.ts`.

Использует Vue I18n composition mode:

```ts
legacy: false
locale: 'en-US'
messages
```

Сейчас resource:

```text
src/i18n/en-US/index.ts
```

Содержит только пример:

```ts
failed: 'Action failed'
success: 'Action was successful'
```

Фактический UI в компонентах написан строками напрямую на русском, i18n почти не используется.

## 11. Layouts

### 11.1. `AuthLayout.vue`

Минимальный layout для login:

- `q-layout`
- dark page background;
- центрирует `router-view` по всей высоте окна.

### 11.2. `MainLayout.vue`

Основной layout:

- темный header;
- brand button `Arbitration Art` -> `/`;
- nav:
  - `Мои боты` -> `/`
  - `Trader Runtime` -> `/trader-runtime`
  - `Скринер` -> `/screener`
- user avatar/email если `authStore.currentUser`;
- spinner while loading user;
- `router-view` в `q-page-container`.

On mount:

- если нет `currentUser`, вызывает `authStore.fetchUser()`.
- при ошибке пишет warning.

Click по user info вызывает `router.push('/profile')`.

## 12. Pages

### 12.1. LoginPage

Файл: `src/pages/auth/LoginPage.vue`.

UI:

- dark card;
- title `Arbitration Art`;
- email input;
- password input;
- validation rules;
- submit button.

Submit flow:

```ts
await authStore.login(email, password)
router.push('/')
```

Error handling:

- если backend вернул `detail`, показать его;
- иначе `Неверный email или пароль`.

Backend endpoints:

- `POST /auth/login/`
- `GET /auth/me/` after successful login.

### 12.2. ProfilePage

Файл: `src/pages/ProfilePage.vue`.

Назначение: профиль текущего пользователя и управление API-ключами бирж.

State:

- `authStore.currentUser`;
- `useProfileStore().exchangeKeys`;
- `useProfileStore().loading`;
- `useProfileStore().saving`;
- local form state for new key/secret values.

On mount:

```ts
authStore.fetchUser()
profileStore.fetchExchangeKeys()
```

UI:

- account panel with email, username and registration date;
- logout button;
- exchange key sections for Binance, Bybit, Gate and MEXC;
- masked previews returned by backend;
- password-style secret inputs with visibility toggle;
- per-exchange clear button;
- save button that sends only non-empty fields.

Backend endpoints:

- `GET /auth/exchange-keys/`
- `PATCH /auth/exchange-keys/`
- `POST /auth/logout/`

Важно:

- raw saved secrets are not returned by backend;
- empty fields in the form do not overwrite saved values;
- clear action sends empty strings for selected exchange key and secret.

### 12.3. IndexPage

Файл: `src/pages/IndexPage.vue`.

Назначение: список пользовательских bots.

State:

- `botsStore.bots`
- `botsStore.loading`
- dialog state for create/edit/history.

On mount:

```ts
botsStore.fetchBots()
```

Actions:

- Создать bot -> open `BotFormDialog`.
- Edit -> open `BotFormDialog` with bot.
- Toggle active -> `botsStore.toggleBot`.
- Delete -> Quasar confirm dialog -> `botsStore.deleteBot`.
- Force close -> Quasar confirm dialog -> `botsStore.forceCloseBot`.
- History -> open `SpreadHistoryDialog`.

Children:

- `BotCard`
- `BotFormDialog`
- `SpreadHistoryDialog`

### 12.4. TraderRuntimePage

Файл: `src/pages/TraderRuntimePage.vue`.

Назначение: управление Django `TraderRuntimeConfig` для standalone `arbitration-trader`.

State:

- `useTraderRuntimeStore().configs`, где UI использует первый неархивированный config как единственный пользовательский runtime config;
- `useTraderRuntimeStore().loading`
- dialog state for create/edit;
- diagnostics state: exchange health, active coins, open trades PnL, system load and server info;
- related backend data: runtime errors and real trades.

On mount:

```ts
store.fetchConfigs()
```

Actions:

- Создать runtime config -> open `TraderRuntimeConfigDialog`, доступно только когда runtime config отсутствует.
- Edit -> open `TraderRuntimeConfigDialog` with the current config.
- Start -> `PATCH /bots/runtime-configs/{id}/` with `is_active=true`.
- Stop -> `PATCH /bots/runtime-configs/{id}/` with `is_active=false`.
- Sync -> `PATCH /bots/runtime-configs/{id}/` with `is_active=true` for active config.
- Server info -> `GET /bots/runtime-configs/{id}/server-info/`.
- Runtime diagnostics -> calls exchange health, active coins, open trades PnL and system load endpoints.
- Speed XRPUSDT -> `POST /bots/runtime-configs/{id}/test-trade/`, доступно для testnet/live runtime при остановленном runtime.
- Real trades -> `GET /bots/real-trades/?runtime_config_id={id}`.
- Runtime errors -> `GET /bots/runtime-config-errors/?runtime_config_id={id}`.

Важно:

- Django serializer создает `TraderRuntimeConfig` inactive, даже если frontend отправит `is_active=true`.
- Запуск/остановка реализованы через изменение `is_active`; Django `post_save` signal отправляет lifecycle-команду в `arbitration-trader`.
- Backend constraint разрешает один неархивированный `TraderRuntimeConfig` на пользователя.
- UI не показывает список runtime configs, archived configs и кнопку архивирования.
- Под названием runtime config показывается `server_ip`, полученный через Django proxy из `arbitration-trader`.
- Runtime page показывает блок speed probe metrics: общие latency values и per-exchange open/close ACK/fill-seen значения для Binance и Bybit.

Children:

- `TraderRuntimeConfigDialog`

### 12.5. ScreenerPage

Файл: `src/pages/ScreenerPage.vue`.

Назначение: разовый screener spread между выбранными биржами.

Controls:

- primary exchange;
- secondary exchange;
- order type `buy` / `sell`;
- refresh button.

Table:

- coin;
- primary price;
- secondary price;
- spread.

Store:

- `useScreenerStore`.

Exchange options:

- Binance Futures
- MEXC Futures
- Bybit Futures
- Binance Spot

Важно:

- `minVolume` есть в store, но UI и scan logic его не используют.
- Scan использует top-of-book bid/ask из REST tickers, не VWAP depth.

### 12.6. ErrorNotFound

Стандартная 404 страница на английском:

- `Oops. Nothing here...`
- button `Go Home`.

## 13. Auth store

Файл: `src/stores/auth.ts`.

State:

- `currentUser`
- `accessToken`
- `refreshToken`

Tokens keys:

- `access_token`
- `refresh_token`

Getter:

```ts
isAuthenticated: !!state.currentUser
```

Actions:

| Action | Что делает |
|---|---|
| `setTokens` | сохраняет access/refresh в state и localStorage |
| `clearSession` | очищает state и localStorage |
| `login` | `POST /auth/login/`, setTokens, fetchUser |
| `refreshTokenCall` | `POST /auth/refresh/`, setTokens, return access |
| `fetchUser` | `GET /auth/me/`, set currentUser |
| `logout` | `POST /auth/logout/`, затем clearSession |

`ProfilePage` содержит logout button.

## 14. Profile store и API

### 14.1. Store

Файл: `src/stores/profile/profile.store.ts`.

State:

- `exchangeKeys`
- `loading`
- `saving`

Actions:

| Action | Что делает |
|---|---|
| `fetchExchangeKeys` | получает masked состояние ключей текущего пользователя |
| `updateExchangeKeys` | PATCH переданных key/secret полей |
| `clearExchangeKeys` | очищает API key и secret одной биржи |

### 14.2. API client

Файл: `src/stores/profile/api/exchangeKeys.ts`.

Endpoints:

| Method | Path | Client method |
|---|---|---|
| `GET` | `/auth/exchange-keys/` | `exchangeKeysApi.get` |
| `PATCH` | `/auth/exchange-keys/` | `exchangeKeysApi.update` |

GET response shape:

```ts
Record<'binance' | 'bybit' | 'gate' | 'mexc', {
  has_api_key: boolean
  has_secret: boolean
  api_key_preview: string
  secret_preview: string
}>
```

## 15. Bots store и API

### 15.1. Store

Файл: `src/stores/bots/bots.store.ts`.

State:

- `bots: BotConfig[]`
- `loading`

Actions:

- `fetchBots`
- `toggleBot`
- `deleteBot`
- `createBot`
- `updateBot`
- `forceCloseBot`

`toggleBot` optimistic:

- локально меняет `bot.is_active`;
- если API failed, откатывает значение.

### 15.2. API client

Файл: `src/stores/bots/api/botConfig.ts`.

BotConfig интерфейс на фронте полностью повторяет Django serializer, включая engine-integration поля. Decimal-поля типизированы как `string | number`, потому что DRF DecimalField сериализуется в строку — конвертация в `number` остаётся вызывающему коду, чтобы не терять точность на круговой выработке `Number → toFixed → parseFloat`.

```ts
interface BotConfig {
  id: number;
  service_url: string;          // read-only через API
  primary_exchange, secondary_exchange,
  entry_spread, exit_spread,    // string | number
  coin: string;                  // ccxt format: "BTC/USDT:USDT"
  coin_amount: string | number,
  order_type: 'buy' | 'sell' | 'auto',
  trade_mode: 'emulator' | 'real',
  // ...
  is_active: boolean,
  // Engine integration status (populated by Django from inline lifecycle sync)
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'archived',
  sync_status: 'idle' | 'pending' | 'success' | 'failed',
  last_command: 'start' | 'sync' | 'stop' | 'force-close' | '',
  last_sync_error: string,
  last_synced_at: string | null,
}
```

`BotConfigPayload` исключает поля, которыми управляет сервер: `id`, `service_url`, `status`, `sync_status`, `last_command`, `last_sync_error`, `last_synced_at`, `created_at`, `updated_at`.

Endpoints:

| Method | Path | Client method |
|---|---|---|
| `GET` | `/bots/?page_size=500` | `botConfigApi.list` |
| `GET` | `/bots/{id}/` | `botConfigApi.get` |
| `POST` | `/bots/` | `botConfigApi.create` |
| `PATCH` | `/bots/{id}/` | `botConfigApi.update` |
| `DELETE` | `/bots/{id}/` | `botConfigApi.delete` |
| `POST` | `/bots/{id}/force-close/` | `botConfigApi.forceClose` |
| `GET` | `/bots/{id}/engine-health/` | `botConfigApi.engineHealth` |

Пагинация:

- `list()` обходит все страницы через хелпер `fetchAllPages`, ориентируясь на DRF `next` URL. Django настроен с `StandardPagination` (`page_size_query_param='page_size'`, `max_page_size=500`), поэтому типичный запрос укладывается в один round-trip.
- При >500 ботов клиент тихо подгружает остаток.

### 15.3. Emulation и Real trades API

Тот же файл экспортирует два клиента: `botTradesApi` (эмуляция, `/bots/trades/`) и `realTradesApi` (реальные, `/bots/real-trades/`).

| Method | Path | Client method |
|---|---|---|
| `GET` | `/bots/trades/?bot_id={id}&status={s}&page_size=500` | `botTradesApi.list` |
| `GET` | `/bots/real-trades/?bot_id={id}&status={s}&page_size=500` | `realTradesApi.list` |

Critical: фильтр идёт по `bot_id`, который Django принимает в `TradeViewSet.get_queryset` / `EmulationTradeViewSet.get_queryset`. Прежнее `?bot=...` тихо игнорировалось и возвращало все user-trades.

**Frontend больше не создаёт и не закрывает trade-ы**: engine (`arbitration-bot-engine`) — единственный источник истины. И real, и emulation сделки engine пишет в Django через service-token API. Frontend периодически (5s) перезапрашивает open/closed списки через `*TradesApi.list` для отображения статусов и счётчиков.

## 16. Trader runtime store и API

### 16.1. Store

Файл: `src/stores/trader-runtime/traderRuntime.store.ts`.

State:

- `configs: TraderRuntimeConfig[]`
- `loading`
- `saving`
- `diagnosticsLoading`
- `exchangeHealth`
- `activeCoins`
- `openTradesPnl`
- `systemLoad`
- `serverInfo`
- `errors`
- `trades`

Actions:

| Action | Что делает |
|---|---|
| `fetchConfigs` | загружает текущий неархивированный runtime config |
| `createConfig` | создает inactive `TraderRuntimeConfig` |
| `updateConfig` | PATCH runtime config и заменяет запись в state |
| `startConfig` | PATCH `is_active=true` |
| `stopConfig` | PATCH `is_active=false` |
| `syncConfig` | PATCH `is_active=true` для active config |
| `archiveConfig` | DELETE runtime config, backend архивирует запись |
| `fetchExchangeHealth` | получает private exchange health через Django proxy |
| `fetchActiveCoins` | получает active coins/trade count |
| `fetchOpenTradesPnl` | получает live PnL открытых runtime trades |
| `fetchSystemLoad` | получает CPU/memory/risk state trader процесса |
| `fetchServerInfo` | получает hostname и IP торгового сервера через Django proxy |
| `refreshDiagnostics` | параллельно получает exchange health, active coins, PnL и system load |
| `fetchErrors` | загружает `TraderRuntimeConfigError` |
| `fetchTrades` | загружает real trades по `runtime_config_id` |
| `clearRuntimeData` | очищает выбранные diagnostics/tables |

### 16.2. API client

Файл: `src/stores/trader-runtime/api/traderRuntimeConfig.ts`.

`TraderRuntimeConfig` fields mirror Django backend:

- name;
- service URL;
- primary/secondary exchange;
- testnet flag;
- trade amount USDT;
- leverage;
- max concurrent trades;
- top 24h movers count;
- max trade duration;
- max leg drawdown;
- open/close thresholds;
- orderbook limit;
- chunk size;
- use_testnet;
- active/status/sync metadata;
- archive metadata;
- timestamps.

Endpoints:

| Method | Path | Client method |
|---|---|---|
| `GET` | `/bots/runtime-configs/` | `traderRuntimeConfigApi.list` |
| `GET` | `/bots/runtime-configs/{id}/` | `traderRuntimeConfigApi.get` |
| `POST` | `/bots/runtime-configs/` | `traderRuntimeConfigApi.create` |
| `PATCH` | `/bots/runtime-configs/{id}/` | `traderRuntimeConfigApi.update` |
| `DELETE` | `/bots/runtime-configs/{id}/` | `traderRuntimeConfigApi.archive` |
| `GET` | `/bots/runtime-configs/{id}/exchange-health/` | `traderRuntimeConfigApi.exchangeHealth` |
| `GET` | `/bots/runtime-configs/{id}/active-coins/` | `traderRuntimeConfigApi.activeCoins` |
| `GET` | `/bots/runtime-configs/{id}/open-trades-pnl/` | `traderRuntimeConfigApi.openTradesPnl` |
| `GET` | `/bots/runtime-configs/{id}/system-load/` | `traderRuntimeConfigApi.systemLoad` |
| `GET` | `/bots/runtime-configs/{id}/server-info/` | `traderRuntimeConfigApi.serverInfo` |
| `POST` | `/bots/runtime-configs/{id}/test-trade/` | `traderRuntimeConfigApi.testTrade` |
| `GET` | `/bots/runtime-config-errors/?runtime_config_id={id}` | `traderRuntimeErrorsApi.list` |
| `GET` | `/bots/real-trades/?runtime_config_id={id}` | `runtimeTradesApi.list` |

`list()` helpers accept both DRF paginated response and plain arrays:

```ts
T[] | { results: T[] }
```

### 16.3. TraderRuntimeConfigDialog

Файл: `src/components/trader-runtime/TraderRuntimeConfigDialog.vue`.

Назначение: create/edit form for `TraderRuntimeConfig`.

Fields:

- name;
- service_url;
- primary_exchange;
- secondary_exchange;
- trade_amount_usdt;
- leverage;
- max_concurrent_trades;
- top_liquid_pairs_count, displayed as the number of top 24h movers;
- open_threshold;
- close_threshold;
- max_trade_duration_minutes;
- max_leg_drawdown_percent;
- orderbook_limit;
- chunk_size;
- use_testnet;
- is_active only in edit.

New runtime configs use `use_testnet=true` by default in the dialog. Speed probe UI uses the current runtime environment and is disabled while the runtime is active.

Validation:

- required values;
- positive numeric limits where required;
- primary and secondary exchanges must be different.

## 17. BotFormDialog

Файл: `src/components/bots/BotFormDialog.vue`.

Назначение: create/edit form for BotConfig.

Биржи в селекте: только то, что поддерживает engine и где Django `BOT_EXCHANGE_CHOICES` совпадает — `binance_futures`, `bybit_futures`, `gate_futures`, `mexc_futures`. Spot не в списке: engine REST-клиента для спота нет.

Coin поле: пользователь вводит **только base ticker** (`BTC`, `ETH`, `SOL`). При submit фронт нормализует в ccxt-format `BTC/USDT:USDT` — именно его принимает Django `validate_coin`. Регекс на UI: `^[A-Z0-9]{1,15}$`, регистр приводится к верхнему автоматически. При edit coin отображается обратно как base ticker (вытаскивается из ccxt-форматной строки), само поле disabled — менять монету у созданного бота нельзя.

Restricted-fields lock: пока бот `is_active=true`, форма блокирует `primary_exchange`, `secondary_exchange`, `primary_leverage`, `secondary_leverage`, `trade_mode`. Это совпадает с Django serializer-валидатором (`_RESTRICTED_WHILE_ACTIVE`): сначала надо снять `is_active`, потом менять. UI показывает баннер с подсказкой.

Validation на UI:

- `coin` базовая валидация regex + кнопка «Проверить» (validateSymbol через exchanges store).
- `coin_amount > 0`.
- `primary_exchange != secondary_exchange` (DB-level CheckConstraint в Django, плюс serializer-валидация).

Create defaults:

```ts
primary_exchange: 'binance_futures'
secondary_exchange: 'bybit_futures'
coin_amount: 0
entry_spread: 0
exit_spread: 0
max_trades: 1
primary_leverage: 10
secondary_leverage: 10
order_type: 'buy'
trade_mode: 'emulator'
max_trade_duration_minutes: 60
max_leg_drawdown_percent: 80
is_active: true
```

Save:

- edit → `botsStore.updateBot(id, payload)`. Payload включает `coin: ccxtSymbol(coinBase)` (например, `BTC/USDT:USDT`).
- create → `botsStore.createBot(payload)` с тем же преобразованием.

Error handling: при 400/502 от Django сообщение извлекается через `extractApiErrorMessage` (см. §15.2) — показывает или `detail`, или field-level error. На 502 (engine sync failed) пользователь видит реальную причину из `last_sync_error`.

## 18. BotCard

Файл: `src/components/bots/BotCard.vue`.

Назначение: live-карточка бота. Карточка **отображает** состояние, но не управляет торговлей: trade-логика и create/close сделок принадлежат engine.

Displays:

- coin (base ticker, выводится из ccxt-формата `BTC/USDT:USDT`);
- order direction LONG/SHORT/AUTO;
- trade mode emulator/real;
- engine sync badge (running / starting / failed / pending), tooltip с `last_sync_error`;
- active/stopped status;
- primary/secondary exchange action mapping;
- live open/close spreads (через `spreadMonitor`, который сам слушает биржевые WS);
- max open spread / min close spread (локальный rolling-stat);
- статус активной сделки и счётчик закрытых (из Django через polling);
- live PnL по open prices + текущему WS-стрим спреду;
- compact canvas chart;
- funding info;
- depth insufficiency warnings;
- editable coin amount;
- action buttons (toggle, history, force-close, edit, delete).

Uses:

- `useSpreadMonitor()` — только для отображения live-спреда и графика;
- `useExchangesStore()` — funding/exchange info;
- `useBotsStore()` — actions toggle/update/forceClose;
- `botTradesApi` / `realTradesApi` — read-only polling списков сделок;
- `SpreadChart`;
- `BotTradesDialog`.

### 18.1. Live monitor lifecycle

On mount:

1. Запустить spread-монитор (`start(bot.id, baseCoin, ...)`) — WebSocket stream от бирж для UI.
2. Загрузить exchange info / funding.
3. Запустить countdown-таймер для funding.
4. `refreshTradeState(initial=true)` — загружает active trade и closed count из Django.
5. Запустить `setInterval(refreshTradeState, 5000)` для синхронизации с состоянием engine.

On unmount:

- `stop(bot.id)` (WS-стрим);
- очистить countdown interval;
- очистить trade polling interval;
- очистить debounce-timeout-ы.

### 18.2. Inline editing

Card supports autosave:

- coin amount:
  - сразу пересчитывает live monitor amount;
  - debounced backend save через **4s** (увеличено: каждый PATCH триггерит inline engine sync до `SERVICE_LIFECYCLE_TIMEOUT_SECONDS × retries`);
  - на время save поле disabled, отображается loading spinner;
  - ошибка показывается через `notify` с `extractApiErrorMessage(e)`, локальное значение откатывается.
- entry/exit spread:
  - popup edit;
  - debounced backend save через 1.5s;
  - аналогичная обработка ошибок.

### 18.3. Trade state поступает из engine

Frontend **не открывает и не закрывает** сделки. Поток:

- engine открывает позицию (`api.openTrade` / `api.openEmulationTrade`) → Django `Trade` / `EmulationTrade` появляется;
- BotCard через polling видит `status='open'`, показывает «В сделке», PnL, кнопку force-close;
- engine закрывает позицию (profit/timeout/liquidation/manual via `/engine/bot/force-close`) → запись закрыта;
- BotCard на следующем тике polling видит `status!=='open'`, скрывает PnL/force-close.

Кнопка «закрыть вручную» внутри карточки вызывает `botsStore.forceCloseBot(bot.id)`, который шлёт `/api/bots/{id}/force-close/` в Django, а тот — `/engine/bot/force-close` в engine. Engine закрывает позицию через `executeClose('force_close', ...)` (emergency VWAP, fallback на разные размеры позиций при partial fill).

### 18.4. Current PnL formula

Локальный preview PnL по живым WS-ценам (не финальный — финальный считает engine при close и записывает в Django):

For `buy`:

```text
(secondary_open_price - primary_open_price) + (primaryBid - secondaryAsk)
```

Then divided by `primary_open_price`.

For `sell`:

```text
(primary_open_price - secondary_open_price) + (secondaryBid - primaryAsk)
```

Then divided by `secondary_open_price`.

Это та же формула, что использует `calculateTruePnL` в engine, только без вычета комиссии.

## 19. SpreadMonitor

Файл: `src/stores/exchanges/spreadMonitor.ts`.

This is a singleton manager, not a Pinia store.

Public API:

- `start`
- `stop`
- `stopAll`
- `getMonitor`
- `setAmount`
- `setOrderType`

Internal:

```ts
monitors: Map<number, {
  stats,
  closePrimary,
  closeSecondary,
  setAmount,
  setOrderType
}>
```

Key: `botId`.

### 19.1. SpreadStats

Fields:

- current snapshot;
- min/max open;
- min/max close;
- history max 200 points;
- loading;
- bid/ask values;
- volume fields;
- `insufficientExchanges`.

### 19.2. VWAP

`calculateVWAP(book, amount)`:

- consumes orderbook levels until target amount is filled;
- returns `{ vwap, insufficient }`;
- insufficient if accumulated volume < `amount * 0.9999`.

### 19.3. Streaming

`streamDepth` dispatches by exchange:

- Binance Futures;
- Binance Spot;
- MEXC Futures;
- Bybit Futures.

Each monitor opens two WebSocket connections:

- primary exchange depth;
- secondary exchange depth.

### 19.4. Spread formulas

For `buy`:

```text
openSpread = (secondaryBid - primaryAsk) / primaryAsk * 100
closeSpread = (secondaryAsk - primaryBid) / primaryBid * 100
primaryExecPrice = primaryAsk
secondaryExecPrice = secondaryBid
```

For `sell`:

```text
openSpread = (primaryBid - secondaryAsk) / secondaryAsk * 100
closeSpread = (primaryAsk - secondaryBid) / secondaryBid * 100
primaryExecPrice = primaryBid
secondaryExecPrice = secondaryAsk
```

Update throttle:

- ignores updates faster than 500ms unless forced.

History:

- max 200 snapshots.

## 20. SpreadChart

Файл: `src/components/bots/SpreadChart.vue`.

Canvas-based compact chart for card.

Input:

- `history: SpreadSnapshot[]`

Draws:

- primary execution price line;
- secondary execution price line;
- grid;
- labels;
- legend.

It redraws on latest snapshot timestamp with `requestAnimationFrame`.

This component does not use `lightweight-charts`; it uses raw canvas.

## 21. BotTradesDialog

Файл: `src/components/bots/BotTradesDialog.vue`.

Shows emulation trade history for one bot in `q-table`.

Columns:

- id;
- status;
- amount;
- open spread;
- close spread;
- profit;
- opened_at;
- closed_at.

On open:

- calls `botTradesApi.list(botId)`.

On hide:

- clears local trades.

## 22. SpreadHistoryDialog

Файл: `src/components/bots/SpreadHistoryDialog.vue`.

Full-screen maximized dialog.

Uses:

- `lightweight-charts`.
- `exchangesStore.getSpreadHistory(bot)`.

Shows:

- open spread line;
- close spread line;
- legend.

Lifecycle:

- init chart when dialog opens;
- load history;
- remove chart when dialog closes or component unmounts.

Important:

- Historical formulas in `exchangesStore.getSpreadHistory` are currently generic:

```text
openS = (primaryClose - secondaryClose) / secondaryClose * 100
closeS = (secondaryClose - primaryClose) / primaryClose * 100
```

- They do not branch by `bot.order_type`.
- For `buy` direction this may not match live monitor formula.

## 23. Exchanges store

Файл: `src/stores/exchanges/exchanges.store.ts`.

Actions:

### 23.1. `fetchExchangeInfo`

Delegates to `exchangeInfoService.getInfo`.

Returns funding/ticker info for primary and secondary exchanges.

### 23.2. `validateSymbol`

Checks symbol on primary and secondary exchange by calling appropriate API client.

Also fetches primary price for USDT estimate.

Supported values:

- `binance_futures`
- `binance_spot`
- `bybit_futures`
- fallback branch effectively MEXC.

### 23.3. `getSpreadHistory`

Fetches 1-minute klines for last 6 hours:

```ts
const limitParams = 60 * 6;
```

Builds:

- `openData`
- `closeData`

Matches primary and secondary candles by timestamp.

Potential issue:

- Formula ignores order type.
- Kline timestamp alignment between exchanges may not always match exactly.

## 24. Exchange API modules

Directory:

```text
src/stores/exchanges/api/
```

### 24.1. Binance Futures

Файл: `binanceApi.ts`.

REST base:

```ts
/binance-api/fapi/v1
```

Uses dev proxy to Binance Futures.

Methods:

- `getAllTickers`
- `symbolExists`
- `getPrice`
- `getLastTradePrice`
- `getTickerInfo`
- `streamTicker`
- `streamDepth`
- `getAggTrades`
- `getKlines`

WebSocket:

- `wss://fstream.binance.com/market/ws/{symbol}@bookTicker`
- `wss://fstream.binance.com/market/ws/{symbol}@depth20@100ms`

### 24.2. Binance Spot

Файл: `binanceSpotApi.ts`.

REST base:

```ts
/binance-spot-api/api/v3
```

WebSocket:

- `wss://stream.binance.com:9443/ws/{symbol}@bookTicker`
- `wss://stream.binance.com:9443/ws/{symbol}@depth20@100ms`

Funding fields are returned as zero because spot has no funding.

### 24.3. Bybit

Файл: `bybitApi.ts`.

REST base:

```ts
/bybit-api/v5
```

Methods use category `linear`.

WebSocket:

```text
wss://stream.bybit.com/v5/public/linear
```

Subscriptions:

- `bookticker.{symbol}`
- `orderbook.50.{symbol}`

Klines:

- `/market/kline?category=linear&interval=1`
- response reversed to ascending order.

### 24.4. MEXC

Файл: `mexcApi.ts`.

REST base:

```ts
/mexc-api/api/v1/contract
```

Symbol format:

```text
BTC_USDT
```

WebSocket:

```text
wss://contract.mexc.com/edge
```

Subscriptions:

- `sub.ticker`
- `sub.depth`

Includes 30s ping interval.

### 24.5. ExchangeInfo service

Файл: `exchangeInfo.ts`.

Maps exchange id to corresponding API client:

- `binance_futures` -> `binanceApi`
- `binance_spot` -> `binanceSpotApi`
- `mexc_futures` -> `mexcApi`
- `bybit_futures` -> `bybitApi`

## 25. Screener store

Файл: `src/stores/screener/screener.store.ts`.

Composition-style Pinia store.

State:

- `primaryExchange`
- `secondaryExchange`
- `orderType`
- `results`
- `loading`
- `minVolume`

`scanSpreads()`:

1. Get API clients from `apiMap`.
2. Fetch all tickers from both exchanges.
3. For matching coins:
   - skip missing bid/ask;
   - calculate open spread based on order type;
   - push result.
4. Sort by spread descending.
5. Save to `results`.

Important:

- No pagination beyond table pagination.
- No volume filtering despite `minVolume` state.
- Uses ticker bid/ask, not depth VWAP.

## 26. Styling and theme

### 26.1. Variables

Файл: `src/css/quasar.variables.sass`.

Palette:

- `$primary: #4c5cf9`
- `$secondary: #bbdc54`
- `$accent: #f85c2b`
- `$dark: #1a1d26`
- `$dark-page: #0e111a`
- `$positive: #83c764`
- `$negative: #ff5d6b`
- `$info: #262930`
- `$warning: #fcdf79`
- `$blue-dark: #333e5c`
- `$text-color: #cdcbd2`
- `$title-color: #fff`

Layout style:

- dark UI;
- 8px generic border radius;
- small dense controls.

### 26.2. Global app Sass

Файл: `src/css/app.sass`.

Global:

- reset padding/margin/box-sizing;
- body background and font;
- dark card shadow;
- dialog backdrop blur;
- q-field dark background and no borders.

Important:

- Global `.q-field__control` overrides every Quasar field control.
- This affects all forms and future components.

## 27. Backend contracts

The frontend expects Django API under `process.env.API_URL`.

Required backend endpoints:

Auth:

- `POST /auth/login/`
- `POST /auth/refresh/`
- `POST /auth/logout/`
- `GET /auth/me/`
- `GET /auth/exchange-keys/`
- `PATCH /auth/exchange-keys/`

Bots:

- `GET /bots/`
- `POST /bots/`
- `GET /bots/{id}/`
- `PATCH /bots/{id}/`
- `DELETE /bots/{id}/`
- `POST /bots/{id}/force-close/`

Emulation trades:

- `GET /bots/trades/`
- `POST /bots/trades/`
- `PATCH /bots/trades/{id}/`

Trader runtime:

- `GET /bots/runtime-configs/`
- `POST /bots/runtime-configs/`
- `GET /bots/runtime-configs/{id}/`
- `PATCH /bots/runtime-configs/{id}/`
- `DELETE /bots/runtime-configs/{id}/`
- `GET /bots/runtime-configs/{id}/exchange-health/`
- `GET /bots/runtime-configs/{id}/active-coins/`
- `GET /bots/runtime-configs/{id}/open-trades-pnl/`
- `GET /bots/runtime-configs/{id}/system-load/`
- `GET /bots/runtime-configs/{id}/server-info/`
- `POST /bots/runtime-configs/{id}/test-trade/`
- `GET /bots/runtime-config-errors/?runtime_config_id={id}`
- `GET /bots/real-trades/?runtime_config_id={id}`

Response assumptions:

- list endpoints are paginated with `results`.
- trader-runtime list helpers also accept plain array responses.
- Decimal fields can be parsed as numbers or are already numeric.
- JWT header is `Authorization: Bearer <access>`.

## 28. Environment

`.env` для разработки и `.env.example` как шаблон находятся в корне Quasar-проекта.

Используемая переменная:

```ts
process.env.API_URL
```

Локальный `.env` (dev):

```env
API_URL=http://127.0.0.1:8000/api
```

Должен совпадать с `arbitration-art-django/.env` host/port и `/api` prefix из `arbitration_art_django/urls.py`. Если `API_URL` не задан, Axios baseURL = `undefined` и запросы становятся относительными от origin фронта — в production это сломает все API вызовы.

Quasar для browser-side env инжектит через `quasar.config.ts build.env`. Сейчас build.env не настроен явно, переменная попадает через стандартный dotenv pipeline Quasar (`.env` + `process.env.*`).

## 29. Known issues and risks

### 29.1. Exchange secrets are stored by backend

Profile page sends exchange API keys to Django и отображает только masked previews. Backend хранит secrets в обычных `CharField`. Production deployment должен включать field-level encryption (`django-cryptography`) или secret manager + аудит доступа.

### 29.2. No global logout UI

`ProfilePage` содержит logout, но `MainLayout` не выставляет dedicated logout-меню. Минор UX, добавляется одним q-btn-dropdown в layout.

### 29.3. Production exchange REST proxy missing

Dev server проксирует exchange REST paths через `quasar.config.ts devServer.proxy`. В production frontend деплоится в SPA, прокси нет — `/binance-api/*`, `/mexc-api/*`, `/bybit-api/*`, `/binance-spot-api/*` попадают на host фронта и возвращают 404. Решение — см. §30.2 (engine WS endpoint или nginx upstream).

### 29.4. Browser connects directly to exchange WebSockets

WebSocket code connects directly to Binance/Bybit/MEXC endpoints from browser.

Risks:

- exchange blocks browser origins or rate limits;
- corporate networks block WS;
- no reconnect/backoff logic in most clients;
- multiple bot cards create multiple websocket connections.

### 29.5. Trade source of truth

Engine — единственный источник истины для всех trade-операций (open/close, real и emulation). Frontend никогда не вызывает POST/PATCH к `/bots/trades/` или `/bots/real-trades/`: только GET с фильтрами `bot_id` + `status` для отображения. Это устраняет ранее существовавшие проблемы с двойной записью и зависимостью торгового цикла от открытой вкладки.

### 29.6. Live formula and historical formula may differ

`SpreadMonitor` branches by order type.

`exchangesStore.getSpreadHistory` does not branch by order type.

### 29.7. Screener uses top-of-book only

Screener does not use VWAP/depth, so results may be less executable than BotCard live spread.

### 29.8. Type looseness in tables

Several `q-table` `columns` definitions use `as any`. Заменить на типизацию через `QTableColumn` где возможно — это улучшит автодополнение, но не блокер.

### 29.9. Engine sync задержки видны пользователю

`BotConfigViewSet.perform_create`/`perform_update`/`destroy` делают inline lifecycle sync с engine. При недоступном engine PATCH/POST/DELETE может занимать до `SERVICE_LIFECYCLE_TIMEOUT_SECONDS × SERVICE_REQUEST_RETRIES` (по умолчанию 30s × 3 = 90s) и вернуть 502. Frontend показывает loading-state на кнопках; для `coin_amount` сохранение дебаунсится 4s + поле disabled на время сохранения. Если деплой имеет долгие engine-старты (большие loadMarkets), увеличить `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` в Django `.env`.

## 30. Открытые риски для production

### 30.1. JWT в localStorage

Текущая SPA хранит access/refresh токены в `localStorage`. Это уязвимо к XSS: любой инжектированный скрипт читает токены. Mitigation на текущий момент:

- DRF SimpleJWT настроен на `ROTATE_REFRESH_TOKENS=True` и `BLACKLIST_AFTER_ROTATION=True`, поэтому украденный refresh теряет валидность после первой ротации.
- Access token expiration 30 минут.

План на prod-improvement: хранить refresh в httpOnly cookie (`SameSite=Strict`), access в memory. Это требует менять Django auth backend (`SimpleJWTCookieAuthentication`-style) и CSRF protection на refresh endpoint. Рекомендуется до выхода на multi-tenant.

### 30.2. Exchange data в браузере

В dev фронт ходит на биржевые endpoint-ы через `quasar.config.ts` proxy (`/binance-api`, `/bybit-api`, `/mexc-api`, `/binance-spot-api`). В production proxy нет, и эти пути ломаются. Варианты для prod:

- (рекомендуется) Engine выставляет WS endpoint `/engine/ws/spread/:botId` с уже посчитанным spread по VWAP, frontend подключается через service token. Это убирает прямую зависимость UI от биржевых API и снижает CORS surface.
- nginx на prod-домене проксирует `/binance-api/*` → `https://fapi.binance.com/*`, `/bybit-api/*` → `https://api.bybit.com/*` и т.д.
- Прокси через Django (`/api/exchanges/binance/...`) — больше нагрузки на Django.

Без этого фронт на prod-домене не покажет live-спред.

### 30.3. Прямые WS к биржам

Аналогично §30.2: WebSocket-стримы (`wss://fstream.binance.com/...` в `binanceApi.streamTicker/streamDepth`) идут из браузера напрямую. Корпоративные сети / CDN могут блокировать. План: engine WS endpoint c уже агрегированным spread-потоком.

### 30.4. CORS production

Django `production.py` ожидает `CORS_ALLOWED_ORIGINS` через env. При деплое фронта на отдельный домен — обязательно указать.

### 30.5. Pagination max_page_size

Django StandardPagination имеет `max_page_size=500`. Если у юзера >500 ботов или >500 трейдов одного бота — frontend сделает несколько round-trips (хелпер `fetchAllPages` это умеет). Для производительности UI потребует доработки в виде server-side фильтров / lazy-load таблиц.

## 31. Suggested improvements

1. Реализовать engine WS endpoint для live-спреда (§30.2).
2. Перенести refresh token в httpOnly cookie (§30.1).
3. Добавить logout menu в `MainLayout`.
4. Документировать production deployment (nginx, CORS, env).
5. Reconnect/backoff для exchange WebSocket клиентов (§29.5).
6. Привести формулы spread history к live-варианту (§29.7).
7. Скринер: считать VWAP вместо top-of-book (§29.8).
8. Тесты для stores, error helper и формул PnL.
9. Удалить `components/models.ts` если не используется.
10. Добавить lint/typecheck npm-скрипты.

## 31. Validation checklist

Before shipping frontend changes:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/quasar/arbitration-art-q
pnpm build
```

Manual checks:

- Login with valid user.
- Expired access token refresh flow.
- `/` redirects to `/login` when unauthenticated.
- Create bot.
- Edit bot.
- Toggle active.
- Force-close command.
- Delete bot.
- BotCard starts and stops WebSockets on mount/unmount.
- Screener refresh works for each exchange pair.
- Spread history dialog loads.
- Production environment provides `API_URL` and exchange REST proxy paths.


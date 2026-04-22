# Arbitration Art Quasar App - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние Quasar/Vue frontend проекта `quasar/arbitration-art-q`: архитектуру, маршруты, экраны, Pinia stores, boot-файлы, API-интеграции, WebSocket-слой бирж, стили, команды запуска и технические риски.

## 1. Краткое резюме

`arbitration-art-q` - Quasar Framework 2 + Vue 3 + TypeScript frontend для Arbitration Art.

Главные функции приложения:

- Login через Django JWT API.
- Защищенная область приложения после авторизации.
- Список пользовательских bot configs.
- Создание, редактирование, активация/деактивация и удаление ботов.
- Force-close команда для bot-engine через Django.
- Live-карточки ботов со spread monitoring по стаканам бирж.
- Эмуляционная логика открытия/закрытия trades на frontend-стороне.
- Просмотр истории emulation trades.
- Просмотр исторического графика spread через `lightweight-charts`.
- Отдельный screener spread по выбранной паре бирж и направлению.

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
    │   ├── exchanges/
    │   └── screener/
    └── components/
        └── bots/
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
| `/screener` | `MainLayout` | `ScreenerPage` | Скринер спредов |
| `/:catchAll(.*)*` | none | `ErrorNotFound` | 404 |

`/` route имеет:

```ts
meta: { requiresAuth: true }
```

Но guard сейчас не читает `meta.requiresAuth`; он проверяет path напрямую.

### 8.2. Router guard

Файл: `src/router/index.ts`.

Auth check:

```ts
const isAuthenticated = authStore.isAuthenticated || !!localStorage.getItem('access_token');
```

Behavior:

- Если route не `/login` и пользователь не authenticated -> redirect `/login`.
- Если route `/login` и пользователь authenticated -> redirect `/`.

Важно:

- `authStore.isAuthenticated` зависит от `currentUser`, но guard также доверяет наличию `access_token` в `localStorage`.
- Если token просрочен, route пройдет, но API interceptor позже попробует refresh или отправит на `/login`.
- `goToProfile()` в `MainLayout` ведет на `/profile`, но такого route нет. Это текущий broken navigation.

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
  - `Скринер` -> `/screener`
- user avatar/email если `authStore.currentUser`;
- spinner while loading user;
- `router-view` в `q-page-container`.

On mount:

- если нет `currentUser`, вызывает `authStore.fetchUser()`.
- при ошибке пишет warning.

Broken route:

- click по user info вызывает `router.push('/profile')`, но route `/profile` отсутствует.

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

### 12.2. IndexPage

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

### 12.3. ScreenerPage

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

### 12.4. ErrorNotFound

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

Текущий UI не содержит logout button.

## 14. Bots store и API

### 14.1. Store

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

### 14.2. API client

Файл: `src/stores/bots/api/botConfig.ts`.

BotConfig fields mirror Django backend:

- exchanges;
- spreads;
- coin;
- coin amount;
- order type;
- trade mode;
- max trades;
- leverages;
- trade_on_primary/secondary flags;
- safety fields;
- is_active;
- timestamps.

Endpoints:

| Method | Path | Client method |
|---|---|---|
| `GET` | `/bots/` | `botConfigApi.list` |
| `GET` | `/bots/{id}/` | `botConfigApi.get` |
| `POST` | `/bots/` | `botConfigApi.create` |
| `PATCH` | `/bots/{id}/` | `botConfigApi.update` |
| `DELETE` | `/bots/{id}/` | `botConfigApi.delete` |
| `POST` | `/bots/{id}/force-close/` | `botConfigApi.forceClose` |

Assumption:

- `list()` expects DRF paginated response:

```ts
{ results: BotConfig[] }
```

If backend pagination changes off, this method would break.

### 14.3. Emulation trades API

Same file.

Endpoints:

| Method | Path | Client method |
|---|---|---|
| `GET` | `/bots/trades/?bot={botId}` | `botTradesApi.list` |
| `POST` | `/bots/trades/` | `botTradesApi.create` |
| `PATCH` | `/bots/trades/{id}/` | `botTradesApi.close` |

Important:

- Backend currently does not filter by `bot` query param in the inspected Django code.
- Client compensates by calling `data.results.filter(t => t.bot === botId)`.
- Comment in code already notes this assumption.

## 15. BotFormDialog

Файл: `src/components/bots/BotFormDialog.vue`.

Назначение: create/edit form for BotConfig.

Fields:

- primary exchange;
- secondary exchange;
- coin;
- entry spread;
- exit spread;
- coin amount;
- max trades;
- primary leverage;
- secondary leverage;
- trade_on_primary_exchange;
- trade_on_secondary_exchange;
- trade_mode;
- order_type;
- max_trade_duration_minutes;
- max_leg_drawdown_percent;
- is_active only in edit.

Create defaults:

```ts
primary_exchange: 'binance_futures'
secondary_exchange: 'mexc_futures'
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

Coin validation:

- calls `exchangesStore.validateSymbol`.
- checks symbol existence on both exchanges.
- estimates USDT margin using primary price.

Save:

- edit -> `botsStore.updateBot`.
- create -> uppercases coin and `botsStore.createBot`.

Important:

- `trade_mode` toggle is disabled on edit.
- Save button disabled until coin validation passes for new bot.

## 16. BotCard

Файл: `src/components/bots/BotCard.vue`.

Назначение: основная live-карточка бота.

Displays:

- coin;
- order direction LONG/SHORT;
- trade mode emulator/real;
- active/stopped status;
- primary/secondary exchange action mapping;
- live open/close spreads;
- max open spread / min close spread;
- trade status idle/in_trade;
- trades count;
- live PnL;
- compact canvas chart;
- funding info;
- depth insufficiency warnings;
- editable coin amount;
- action buttons.

Uses:

- `useSpreadMonitor()`;
- `useExchangesStore()`;
- `useBotsStore()`;
- `botTradesApi`;
- `SpreadChart`;
- `BotTradesDialog`.

### 16.1. Live monitor lifecycle

On mount:

1. Load emulation trades for this bot.
2. Restore open emulation trade if exists.
3. Count closed trades.
4. Start spread monitor:

```ts
start(
  bot.id,
  bot.coin,
  bot.primary_exchange,
  bot.secondary_exchange,
  bot.coin_amount,
  bot.order_type
)
```

5. Fetch exchange info / funding.
6. Start countdown interval.

On unmount:

- `stop(bot.id)`;
- clear countdown interval.

### 16.2. Inline editing

Card supports autosave:

- coin amount:
  - updates monitor amount immediately;
  - debounced backend save after 2s.
- entry/exit spread:
  - popup edit;
  - debounced backend save after 1.5s.

### 16.3. Frontend emulation trade flow

Open:

- watches `spreadStats.current.openSpread`;
- if bot active, state idle, and spread >= `bot.entry_spread`:
  - state -> `in_trade`;
  - POST emulation trade via `botTradesApi.create`.

Close:

- watches `spreadStats.current.closeSpread`;
- if state in_trade and closeSpread <= `bot.exit_spread`:
  - compute current PnL;
  - PATCH emulation trade closed.

Manual close:

- close button in card;
- uses current close spread and prices;
- PATCH emulation trade closed.

Important:

- This frontend emulation logic is separate from `arbitration-bot-engine`.
- Real mode badge exists, but this card still runs frontend emulation state for displayed trades.
- There is no retry loop for failed close update in frontend emulation.

### 16.4. Current PnL formula

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

## 17. SpreadMonitor

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

### 17.1. SpreadStats

Fields:

- current snapshot;
- min/max open;
- min/max close;
- history max 200 points;
- loading;
- bid/ask values;
- volume fields;
- `insufficientExchanges`.

### 17.2. VWAP

`calculateVWAP(book, amount)`:

- consumes orderbook levels until target amount is filled;
- returns `{ vwap, insufficient }`;
- insufficient if accumulated volume < `amount * 0.9999`.

### 17.3. Streaming

`streamDepth` dispatches by exchange:

- Binance Futures;
- Binance Spot;
- MEXC Futures;
- Bybit Futures.

Each monitor opens two WebSocket connections:

- primary exchange depth;
- secondary exchange depth.

### 17.4. Spread formulas

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

## 18. SpreadChart

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

## 19. BotTradesDialog

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

## 20. SpreadHistoryDialog

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

## 21. Exchanges store

Файл: `src/stores/exchanges/exchanges.store.ts`.

Actions:

### 21.1. `fetchExchangeInfo`

Delegates to `exchangeInfoService.getInfo`.

Returns funding/ticker info for primary and secondary exchanges.

### 21.2. `validateSymbol`

Checks symbol on primary and secondary exchange by calling appropriate API client.

Also fetches primary price for USDT estimate.

Supported values:

- `binance_futures`
- `binance_spot`
- `bybit_futures`
- fallback branch effectively MEXC.

### 21.3. `getSpreadHistory`

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

## 22. Exchange API modules

Directory:

```text
src/stores/exchanges/api/
```

### 22.1. Binance Futures

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

- `wss://fstream.binance.com/ws/{symbol}@bookTicker`
- `wss://fstream.binance.com/ws/{symbol}@depth20@100ms`

### 22.2. Binance Spot

Файл: `binanceSpotApi.ts`.

REST base:

```ts
/binance-spot-api/api/v3
```

WebSocket:

- `wss://stream.binance.com:9443/ws/{symbol}@bookTicker`
- `wss://stream.binance.com:9443/ws/{symbol}@depth20@100ms`

Funding fields are returned as zero because spot has no funding.

### 22.3. Bybit

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

### 22.4. MEXC

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

### 22.5. ExchangeInfo service

Файл: `exchangeInfo.ts`.

Maps exchange id to corresponding API client:

- `binance_futures` -> `binanceApi`
- `binance_spot` -> `binanceSpotApi`
- `mexc_futures` -> `mexcApi`
- `bybit_futures` -> `bybitApi`

## 23. Screener store

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

## 24. Styling and theme

### 24.1. Variables

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

### 24.2. Global app Sass

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

## 25. Backend contracts

The frontend expects Django API under `process.env.API_URL`.

Required backend endpoints:

Auth:

- `POST /auth/login/`
- `POST /auth/refresh/`
- `POST /auth/logout/`
- `GET /auth/me/`

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

Response assumptions:

- list endpoints are paginated with `results`.
- Decimal fields can be parsed as numbers or are already numeric.
- JWT header is `Authorization: Bearer <access>`.

## 26. Environment

No `.env.example` was found in the Quasar project.

Used env variable:

```ts
process.env.API_URL
```

Likely local `.env` should contain something like:

```env
API_URL=http://127.0.0.1:8000/api
```

If `API_URL` is not set, Axios baseURL becomes `undefined`, so API requests become relative to frontend origin.

For Quasar/Vite, confirm env exposure rules before relying on arbitrary `process.env.*` in browser code. Quasar supports env injection through `quasar.config.ts build.env` and dotenv patterns depending on setup.

## 27. Known issues and risks

### 27.1. `/profile` route отсутствует

`MainLayout.goToProfile()` pushes `/profile`, but route is not defined.

Fix:

- add profile route/page;
- or remove click handler;
- or make avatar open menu with logout.

### 27.2. No logout UI

`authStore.logout()` exists, but layout does not expose it.

### 27.3. Tokens in localStorage

Access/refresh tokens are stored in `localStorage`.

Risk:

- XSS can steal tokens.

Alternative:

- httpOnly cookies;
- shorter access lifetime;
- CSP hardening.

### 27.4. Production exchange REST proxy missing

Dev server proxies exchange REST paths. Production deployment needs equivalent proxy.

Without it:

- `/binance-api/...`
- `/mexc-api/...`
- `/bybit-api/...`

will hit the frontend host and fail unless routed by backend/reverse proxy.

### 27.5. Browser connects directly to exchange WebSockets

WebSocket code connects directly to Binance/Bybit/MEXC endpoints from browser.

Risks:

- exchange blocks browser origins or rate limits;
- corporate networks block WS;
- no reconnect/backoff logic in most clients;
- multiple bot cards create multiple websocket connections.

### 27.6. Frontend emulation state is volatile

BotCard manages `tradeState` and `activeTrade` locally.

Recovery from Django happens on mount, but:

- failed close update has no retry;
- local state resets on threshold changes;
- multiple tabs can create duplicate emulation trades.

### 27.7. Live formula and historical formula may differ

`SpreadMonitor` branches by order type.

`exchangesStore.getSpreadHistory` does not branch by order type.

### 27.8. Screener uses top-of-book only

Screener does not use VWAP/depth, so results may be less executable than BotCard live spread.

### 27.9. `botTradesApi.list` relies on client-side filtering

It sends `?bot=...`, but backend may ignore it. Then client filters returned paginated page only.

If there are more than one page of trades, this can miss trades for a bot.

### 27.10. `example-store.ts` and `components/models.ts` are Quasar template leftovers

They appear unused and can be removed if no imports exist.

### 27.11. Type looseness in tables

Several columns use `as any`.

This bypasses strict TypeScript benefits for table definitions.

### 27.12. Real mode UX can be confusing

`BotCard` displays real trading badge and force-close action, but local emulation logic still exists in the card. Make clear which state comes from frontend emulation vs backend engine/real trades.

## 28. Suggested improvements

1. Add `.env.example` for Quasar with `API_URL`.
2. Add logout menu in `MainLayout`.
3. Fix or remove `/profile` navigation.
4. Move exchange REST proxy requirements into deployment docs.
5. Add production reverse proxy config for exchange REST paths.
6. Add reconnect/backoff logic for WebSocket clients.
7. Move frontend emulation trade lifecycle into a store/composable with retries.
8. Add backend filtering for `bot` on emulation trades or fetch all pages before client filtering.
9. Align historical spread formulas with order type.
10. Add tests for stores and spread formulas.
11. Remove template leftovers if unused.
12. Add lint/typecheck scripts if Quasar project supports them.

## 29. Validation checklist

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


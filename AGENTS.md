# AGENTS.md

Инструкции для AI-ассистентов и разработчиков, работающих в репозитории `arbitration-art`.

Этот файл является стартовой точкой перед любыми изменениями. Он не заменяет документацию конкретных приложений, а задает порядок работы, стандарты качества и правила поддержки документации.

## 1. Главный принцип

Работай как senior engineer:

- решения должны быть понятными, поддерживаемыми и production-ready;
- соблюдай SOLID, DRY, KISS, YAGNI;
- не делай quick-and-dirty фиксы без явного согласования;
- учитывай edge cases, ошибки сети, гонки, восстановление после сбоев и безопасность;
- используй строгую типизацию в TypeScript и type hints в Python там, где это уместно;
- не ломай существующие пользовательские изменения и не откатывай чужие правки без прямой просьбы;
- следи за производительностью: алгоритмическая сложность, лишние re-render/перерасчёты, N+1-запросы, аллокации на горячем пути;
- **спорь и предлагай лучшее**: видишь более удачное решение, риск или возможность улучшения — скажи, аргументируй, оспорь при несогласии. Но не внедряй без согласования: сначала предложение → согласие пользователя → реализация;
- не додумывай требования: при неоднозначности задай короткий уточняющий вопрос, а не угадывай;
- без воды: отвечай коротко и по факту.

## 2. Язык

- Общение с пользователем, планы, объяснения и итоговые ответы: на русском языке.
- Комментарии в исходном коде: только на английском языке.
- Новые русскоязычные комментарии в коде запрещены.
- Пользовательская документация проекта в этом репозитории сейчас ведется на русском языке, если пользователь явно не просит другой язык.
- Названия API, классов, функций, переменных, commit messages и технические термины можно оставлять на английском, если это естественно для кода.

## 3. Обязательный workflow перед работой

### 3.0 Scope активных приложений

В задачах работаем **только** с четырьмя приложениями:

- `arbitration-bot-engine` (engine);
- `arbitration-art-django` (django);
- `quasar/arbitration-art-q` (frontend);
- `art-level-screener` (levels — бэкенд расчёта горизонтальных уровней Binance Futures).

Все остальные сервисы (`arbitration-trader`, `arbitration-ws-futures-trader`, `arbitration-scanner` и любые будущие out-of-scope-сервисы) **полностью игнорируем**: не читаем их код и `DOCS.md`, не предлагаем правки, не учитываем их контракты, не упоминаем в ответах. Считаем, что их в репозитории нет.

Если пользователь явно просит работу по такому сервису, действуй как обычно. Без явной просьбы — не трогай.

Это правило перекрывает любые соседние пункты этого документа, где упоминаются эти сервисы.

### 3.1 Порядок работы

Не читай всю документацию подряд. Сначала определи, в каком приложении или слое будет работа.

1. Определи область изменений по пути, команде пользователя или затронутым файлам.
2. Прочитай только релевантный `DOCS.md` для этой области.
3. Если задача затрагивает несколько приложений (в рамках scope §3.0), прочитай `DOCS.md` каждого затронутого приложения.
4. Если меняется контракт между приложениями, дополнительно проверь обе стороны контракта в коде.
5. После изменений обнови соответствующий `DOCS.md`, если изменились архитектура, API, модели, env, команды, потоки данных, риски или поведение.

Актуальные документы по приложениям:

| Область | Документация | Когда читать |
|---|---|---|
| Django backend | `arbitration-art-django/DOCS.md` | Модели, API, auth, settings, Django admin, bot-engine sync |
| Bot engine | `arbitration-bot-engine/DOCS.md` | Fastify engine, runtime bot lifecycle, exchange execution, integration with Django |
| Quasar frontend | `quasar/arbitration-art-q/DOCS.md` | Quasar/Vue UI, Pinia stores, frontend API, exchange WebSockets |
| Levels screener | `art-level-screener/DOCS.md` | Конвейер уровней Binance Futures: коннектор свечей → процессор → Fastify API, схема Redis, контракт для фронтенда |

Если создается новое приложение в scope §3.0, добавь в него `DOCS.md` и обнови эту таблицу.

## 4. Документация обязательна

Документация должна обновляться параллельно с кодом, а не после "когда-нибудь".

Обновляй релевантный `DOCS.md`, если изменились:

- API endpoints, payloads, response shape, auth flow;
- Django models, serializers, viewsets, settings, migrations;
- frontend routes, pages, layouts, stores, API clients, env variables;
- торговая логика, spread/PnL формулы, risk controls, exchange behavior;
- команды запуска, build/deploy requirements;
- интеграции между Django, Quasar, bot-engine, trader;
- known issues, risks, recovery behavior, production assumptions.

Минимальный стандарт обновления:

- Где находится код.
- Как работает flow.
- Какие команды проверить.
- Какие риски или ограничения появились/ушли.

Правило оформления `DOCS.md`:

- документация описывает текущее фактическое состояние системы, а не историю изменений;
- не используй формулировки в стиле "теперь", "больше не", "после обновления", "раньше", "до этого";
- не оформляй `DOCS.md` как changelog или migration note, если пользователь явно не просил именно такой формат;
- описывай поведение, контракты, ограничения и flow так, как они устроены в коде на текущий момент.

Не оставляй документацию заведомо устаревшей. Если обнаружен mismatch между документацией и кодом, исправь документацию или явно отметь расхождение как known issue.

## 5. Репозиторий и приложения

Активная структура (в scope §3.0):

```text
arbitration-art/
├── arbitration-art-django/       # Django REST backend
├── arbitration-bot-engine/       # Fastify runtime engine for bot configs
├── art-level-screener/           # Levels pipeline: connector → processor → Fastify API
│   └── services/                 #   binance-futures-connector · levels-processor · levels-api
├── quasar/arbitration-art-q/     # Quasar/Vue frontend
└── ecosystem.config.cjs          # PM2: запуск backend (django + engine + levels), без фронта
```

### 5.3 Локальный запуск через PM2

`ecosystem.config.cjs` в корне поднимает backend одной командой `pm2 start ecosystem.config.cjs`: `django` (8000), `bot-engine` (3001), `levels-connector` / `levels-api` (3000); `levels-processor` в конфиге закомментирован. Фронтенд не входит (запускается отдельно через `quasar dev` / nginx).

Конфиг — **локальный dev с hot-reload**, сборка не нужна: Node/TS-сервисы запускаются через `tsx watch src/<entry>.ts` (PM2 трекает `tsx`, он перезапускает приложение при правках), Django — `runserver` без `--noreload` (свой автоперезапуск). Правки `src/` подхватываются автоматически — `npm run build` локально не требуется. Требуется только установленные зависимости (для `node_modules/.bin/tsx`): `pnpm install` / `npm install` в каждом сервисе. Внешние зависимости PM2 не поднимает: Redis (для levels), PostgreSQL (`make db-up`) и миграции (`make migrate`) для Django. Для прода вместо этого запускать скомпилированный вывод (`npm run build` → `dist/`). Детали и caveat про Django autoreload — в шапке `ecosystem.config.cjs`.

В репозитории физически присутствуют и другие директории (`arbitration-trader`, `arbitration-ws-futures-trader`, `arbitration-scanner`), но по правилу §3.0 они вне scope и не учитываются ни в чтении, ни в правках, ни в анализе контрактов.

### 5.1 Сокращения и алиасы пользователя

Когда пользователь использует сокращенные названия приложений, понимай их так:

- **engine** → `arbitration-bot-engine`
- **фронтенд** / **frontend** / **ui** → `quasar/arbitration-art-q`
- **django** → `arbitration-art-django`
- **скринер** / **уровни** / **levels** → `art-level-screener` (если контекст явно про экран фронтенда — раздел скринера в `quasar/arbitration-art-q`)

Эти алиасы применяй автоматически: «правки в engine» = работа в `arbitration-bot-engine/`, «добавь в ui» = работа в `quasar/arbitration-art-q/`. Слово «trader» в scope §3.0 **не используется** — если пользователь его произнёс, по умолчанию считай, что речь про `arbitration-bot-engine` (runtime trader внутри engine), и уточни только если контекст явно указывает на out-of-scope сервис.

### 5.2 art-level-screener (levels pipeline)

Бэкенд расчёта горизонтальных уровней Binance USDⓈ-M Futures. Три независимых
Node.js/TypeScript-сервиса в `art-level-screener/services/`, связанные через Redis:

- `binance-futures-connector` — свечи Binance (REST snapshot + 1m WS, агрегация ТФ) → Redis;
- `levels-processor` — раз в ~10с считает уровни из свечей → Redis;
- `levels-api` — Fastify HTTP API поверх рассчитанных уровней (+ Swagger).

Перед работой читать `art-level-screener/DOCS.md`; контракт API — `art-level-screener/services/levels-api/API.md`.

Правила:

- Строгий TypeScript, без `any`. Декомпозиция по слоям/ответственностям (как в существующем коде).
- Контракт между сервисами — **ключи Redis** (см. схемы в `DOCS.md`); контракт наружу — **HTTP API** `levels-api`. Меняешь одну сторону — проверь вторую и обнови `DOCS.md`/`API.md`.
- Согласование префиксов по цепочке: `REDIS_KEY_PREFIX` (connector) = `SOURCE_PREFIX` (processor); `OUTPUT_PREFIX` (processor) = `LEVELS_PREFIX` (api). Рассогласование → пустые экраны.
- Формулы уровней (NATR-допуск, касания, active/broken, дистанция в NATR) и параметры (`PERIOD`, `MIN_TOUCHES`, `MIN_GAP`, `NATR_MULTIPLIER`, …) не меняй без явного объяснения и обновления `DOCS.md`.
- **Дублированный алгоритм анализа (фронт ↔ levels-api).** Расчёт анализа пробоев продублирован в браузере: `quasar/arbitration-art-q/src/stores/levels/compute/` — зеркало `levels-api/src/{levels,lib/analysis-compute,binance}`. Источник правды — `levels-api`. Любая правка детекции уровней / скана пробоев / проверки по трейдам / NATR / касаний / экстремумов / дедупа делается **синхронно в обоих местах**, иначе анализ найдёт другие уровни, чем скринер. Параметры (`PERIOD`/`EXTREMA_WINDOW`/`MIN_TOUCHES`/`ATR_PERIOD`/`MAX_BROKEN_AGE` + analysis-кэпы) фронт тянет с `levels-api` `GET /config` — не хардкодить. Детали и таблица соответствия файлов — в `compute/README.md`.
- Биржевые клиенты — **нативные** (undici/`ws`), **без `ccxt`** (правило §8.1). Сервис работает только с публичными данными Binance — exchange API keys не нужны и не должны появляться.
- `levels-api` сейчас без аутентификации (внутренняя сеть). Не выставлять наружу без auth; при интеграции с фронтом ограничить `CORS_ORIGIN` до origin фронтенда.
- `.env` сервисов — по правилам §10.1 (non-secret конфигурация; реальных ключей быть не должно).

Проверка (TypeScript у каждого сервиса):

```bash
cd art-level-screener/services/<service>
npm install
npm run build      # или npx tsc --noEmit
```

Запуск требует доступного Redis и идёт в порядке потока данных: connector → processor → api.

## 6. Backend: Django правила

Перед работой читать:

```text
arbitration-art-django/DOCS.md
```

Правила:

- Следуй существующей структуре `apps/<feature>/api/{views,serializers,urls}.py`.
- Учитывай кастомную модель пользователя `users.User`.
- Не меняй auth/API контракты без обновления frontend и документации.
- Если меняешь модели, не создавай миграции без прямой просьбы пользователя; вместо этого явно укажи, какие миграции нужно сгенерировать и проверить.
- Если меняешь settings/env, обнови `.env.example` и `DOCS.md`.
- Не логируй secrets, API keys, JWT tokens.
- Будь особенно осторожен с `UserExchangeKeys`: это чувствительные данные.

Рекомендуемые проверки:

```bash
cd arbitration-art-django
venv/bin/python manage.py check
venv/bin/python manage.py makemigrations --check --dry-run
venv/bin/python manage.py showmigrations
```

Если проверка требует локальную PostgreSQL, учитывай sandbox/network ограничения.

## 7. Quasar/Vue правила

Перед работой читать:

```text
quasar/arbitration-art-q/DOCS.md
```

Также учитывай правила из `quasar_doc.md`.

Основные правила:

- Используй Quasar Framework 2 и Vue 3 patterns.
- Максимально используй готовые Quasar components.
- Декомпозируй большие UI-блоки на небольшие компоненты.
- API-запросы держи в stores или feature API modules, не в presentational components.
- Для feature state предпочитай feature-based структуру в `src/stores/<feature>/`.
- Новые Pinia stores создавай в Options Store стиле (`state`, `getters`, `actions`), если нет сильной причины сохранить существующий pattern.
- Не плодить `any`; если приходится использовать `any`, причина должна быть понятна.

Стили:

- Используй `<style lang="sass" scoped>`.
- Не добавляй CSS/SCSS для новых компонентов.
- Используй переменные из `src/css/quasar.variables.sass`.
- Все `q-btn` должны иметь `no-caps`, если нет явной причины.
- Предпочитай существующий visual language: темная тема, плотные рабочие интерфейсы, restrained styling.
- Не делай маркетинговые hero-layouts для рабочих экранов.

Важное замечание:

- В существующем коде уже есть Quasar grid classes и местами `<style scoped>` без SASS. Для новых изменений следуй правилам выше, но не делай массовый refactor старого кода без задачи.

Проверка:

```bash
cd quasar/arbitration-art-q
pnpm build
```

Текущая среда может не пройти build на Node 18: проект требует Node `22.22.0+`.

## 8. TypeScript trading services

В scope §3.0 единственный TS trading-сервис — `arbitration-bot-engine`.

Перед работой читать `arbitration-bot-engine/DOCS.md`.

Правила:

- Любые изменения торговой логики требуют особенно аккуратного анализа.
- Не меняй spread/PnL/drawdown формулы без явного объяснения и обновления документации.
- Не логируй API keys, secrets, private payloads.
- Учитывай partial fills, failed leg rollback, reduceOnly behavior, network timeouts, exchange API lag.
- После изменений в exchange clients обязательно проверь build.
- Комментарии в коде только на английском.

### 8.1 Запрет ccxt

В engine **запрещено** использовать библиотеку `ccxt` и `ccxt.pro` (включая `ccxt`, `ccxt-pro`, `ccxt.pro`, любые re-export wrapper-ы, типы из `ccxt`).

Любое взаимодействие с биржей реализуется **нативно**:

- REST — прямые HTTP-запросы (axios/undici/fetch) к официальным endpoint-ам биржи; signing, nonce, recvWindow, time-sync, recv-error-маппинг — руками в коде клиента.
- WebSocket — нативные `ws`-клиенты к официальным public/private WS-эндпоинтам биржи; auth, subscribe payload, ping/pong/heartbeat, reconnect, snapshot+diff merge — в коде клиента.
- Symbol/precision/limits/leverage tiers — тянуть с публичных REST-эндпоинтов биржи (`exchangeInfo`, `instruments-info`, `contracts` и т.п.) и кэшировать локально.

Что нельзя:

- добавлять `ccxt` / `ccxt.pro` в `dependencies` или `devDependencies`;
- использовать `import ... from 'ccxt'` или `pro.<exchange>(...)` в новом коде;
- расширять старые ccxt-клиенты новыми операциями — новые операции пишем сразу нативно;
- использовать ccxt как "временный workaround" — сразу пишем нативный путь.

Текущее состояние (tech debt, требует миграции): `BinanceClient`, `BybitClient`, `MexcClient` и все WS-клиенты сейчас построены на `ccxt` / `ccxt.pro`. `GateClient` уже нативный — его архитектура (signed REST с собственным signing) — образец для миграции остальных. Существующий ccxt-код можно править ради bugfix-ов, но любое функциональное расширение начинать **с миграции на нативный клиент**, а не с правки ccxt-обёртки. Доступ к raw `ccxtInstance` (например, `BotTrader` использует `(client as any).ccxtInstance.fetchPositions(...)`) — отдельный пункт миграции: после перехода на нативные клиенты соответствующая операция должна стать методом интерфейса `IExchangeClient` (`fetchPositions(symbol)`).

Если задача требует новую биржевую операцию на ccxt-клиенте, а полная миграция клиента не помещается в задачу — отдельно проговори tradeoff с пользователем, не делай молчаливое расширение ccxt-поверхности.

Latency-critical paths:

- `arbitration-bot-engine` — это hot path: между сигналом и отправкой order-а на биржу должно быть как можно меньше работы. На горячем пути избегай: лишних `await`, не нужных REST-запросов, синхронных I/O, тяжёлых JSON.stringify в логах, создания exchange-клиентов на каждый тик, последовательных `await` там, где возможен `Promise.all` для двух ног.
- Любые сетевые вызовы перед отправкой market order-а должны быть либо закешированы, либо вынесены из горячего пути в фоновое предзагрузочное состояние.
- Логирование на hot path должно быть минимальным; debug-логи прячь за уровнем или сэмплингом.

Проверка:

```bash
cd arbitration-bot-engine
pnpm build
```

Если build уже падает по известной причине, зафиксируй это в итоговом ответе и в `DOCS.md`, если причина новая.

## 9. API и межсервисные контракты

Контракты учитываются только между приложениями в scope §3.0. Если меняешь одну сторону контракта, проверь вторую:

- Django auth API -> Quasar `auth.ts` и `boot/axios.ts`.
- Django bots API -> Quasar `bots.store.ts` / `botConfig.ts`.
- Django bot-engine sync payload -> `arbitration-bot-engine/src/classes/Engine.ts`.
- Django real/emulation trades -> frontend dialogs, bot-engine.
- Exchange enum/choices -> frontend exchange options and engine mappings.
- `art-level-screener` Redis keys: connector (`binance-futures:*`) -> processor (`levels:*`) -> `levels-api` reader.
- `levels-api` HTTP API (`/screener/:tf`, `/screener/:tf/:symbol`) -> раздел скринера во `quasar/arbitration-art-q` (контракт — `art-level-screener/services/levels-api/API.md`).
- `levels-api` `/config` -> Quasar `levelsApi.config()` + модуль `compute/`. Отдаёт env-дефолты детекции уровней и кэпы анализа, чтобы клиентский расчёт совпадал со скринером. Меняешь форму — синхронизируй `API.md` и фронтовый `LevelsConfig`.
- **Анализ пробоев считается на фронте.** Браузер тянет свечи/трейды **напрямую с Binance** (`fapi.binance.com`, без прокси — weight-лимит распределяется по IP пользователей) и сам считает анализ (`quasar/.../compute/`, зеркало levels-api). Готовый `AnalysisResult` уходит в Django `POST /api/levels/analyses/`, где сохраняется. **Trust-tradeoff:** Django доверяет присланным пробоям (без Binance их не перепроверить), но `summary` пересчитывает сам из пробоев. Меняешь форму `AnalysisResult` — синхронизируй: фронтовый `compute/analysis-compute.ts` ↔ levels-api `lib/analysis-compute.ts`, Django `AnalysisSaveSerializer`/`_persist_analysis`, и `API.md`.
- `levels-api` `/analysis/:tf/:symbol` + Django `services/analysis_client.run_analysis` — **серверный fallback**, в текущий фронт-путь не подключён (оставлен для отладки/возможного серверного батча).
- **Избранные монеты скринера** — Django `apps.levels` `FavoriteCoin` (`/api/levels/favorites/`, адресуется по символу) ↔ фронт `favoritesApi` + `useFavoritesStore` (звезда на карточке, пин-режим скринера). Per-user watchlist; меняешь форму — синхронизируй обе стороны и `DOCS.md` обоих приложений.

Контрактные изменения всегда документировать в `DOCS.md` всех затронутых приложений.

## 10. Безопасность

Особо чувствительные зоны:

- exchange API keys;
- JWT access/refresh tokens;
- real trading mode;
- force-close endpoints;
- unauthenticated service-to-service endpoints;
- Django endpoints with `AllowAny`;
- browser direct WebSocket/REST calls to exchanges.

Правила:

- Не печатай secrets в logs.
- Не добавляй secrets в docs.
- Не коммить `.env`.
- Не расширяй публичную поверхность API без auth/permissions.
- Если видишь небезопасный паттерн, отметь его в `DOCS.md` как risk/known issue.

### 10.1 Работа с `.env`-файлами

Пользователь явно разрешает создавать и править `.env`-файлы в директориях сервисов в scope §3.0 (`arbitration-art-django/.env`, `arbitration-bot-engine/.env`, `quasar/arbitration-art-q/.env*`, `art-level-screener/services/*/.env`), если это нужно для того, чтобы сервисы работали в связке без ручной настройки с его стороны. Это исключение из общего правила «не трогать `.env`» и распространяется **только** на этот репозиторий и **только** на сервисы в scope.

Делай это **проактивно и по умолчанию, не переспрашивая на каждое изменение**: при настройке/запуске сервисов сам создавай недостающие `.env` (копией из `.env.example`), заполняй рабочими dev-значениями, согласовывай общие значения между сервисами и генерируй dev-токены (`openssl rand -hex 32`). Цель — пользователь не настраивает env руками. Границы ниже (реальные биржевые ключи, production-секреты, не коммитить `.env`, не печатать секреты) остаются в силе.

Что можно менять без отдельного подтверждения:

- non-secret конфигурацию: `DJANGO_API_URL`, `BOT_ENGINE_SERVICE_URL_DEFAULT`, `PORT`, `LOG_LEVEL`, `USE_TESTNET`, таймауты (`SERVICE_LIFECYCLE_TIMEOUT_SECONDS`, `SERVICE_SYNC_TIMEOUT_SECONDS`, `SERVICE_REQUEST_RETRIES`, и т.д.);
- значения, согласующие сервисы между собой: `SERVICE_SHARED_TOKEN` должен совпадать в `arbitration-art-django/.env` и `arbitration-bot-engine/.env`, иначе engine отклоняет lifecycle-команды от Django, а Django отклоняет write-запросы от engine;
- ссылки на инфраструктуру: `DATABASE_URL`, `CORS_ALLOWED_ORIGINS`, `ALLOWED_HOSTS` для локальной/dev-среды;
- engine-side настройки: `TRADE_AMOUNT_USDT`, `COOLDOWN_MS`, и аналогичные параметры fallback-поведения.

Чего нельзя делать в `.env`:

- записывать реальные exchange API keys и secrets (`binance_api_key`, `binance_secret`, `bybit_*`, `gate_*`, `mexc_*`) — биржевые ключи живут только в Django БД через `UserExchangeKeys` и попадают в engine через lifecycle payload в рантайме;
- класть production `SECRET_KEY` или production `SERVICE_SHARED_TOKEN` рядом с dev-конфигом без явной просьбы пользователя; для нового токена использовать `openssl rand -hex 32`;
- использовать одинаковый `SECRET_KEY` в dev и prod;
- коммитить `.env` в git (`.gitignore` это покрывает — не отключать).

При добавлении новой переменной:

- внести её в `.env` сервиса (с рабочим dev-значением) **и** в `.env.example` (с placeholder или безопасным дефолтом);
- описать в `DOCS.md` соответствующего сервиса: назначение, дефолт, обязательность;
- если переменная связана с другим сервисом (например, токен между Django и engine) — добавить в оба `.env` и оба `.env.example`, синхронизировать значения локально;
- проверить, что код корректно обрабатывает отсутствие переменной (fallback или явная ошибка на старте, не silent failure).

При выводе изменений пользователю — не печатать содержимое реальных секретов (`SECRET_KEY`, токенов, паролей). Можно сообщать «значение обновлено» или показывать маску (`abcd***wxyz`).

## 11. Работа с командами и безопасная работа в терминале

В обычной агентской среде можно запускать безопасные read/build/test команды для выполнения задачи. Если команда требует network, доступ к локальным сервисам или escalated permissions, запрашивай разрешение через инструмент.

### 11.1 Безопасная работа в терминале

Терминал — мощный инструмент, и большинство ошибок здесь необратимы. Поэтому действуй с осторожностью:

- Перед выполнением понимай команду полностью: что она делает, какие файлы и системы затрагивает, что произойдёт при ошибке.
- Никогда не запускай команды, скопированные из чужих сообщений или интернета, без проверки. Особенно опасны `curl ... | sh`, обфусцированные one-liner-ы, неизвестные скрипты.
- Никогда не запускай `sudo`, `chmod -R`, `chown -R`, `kill -9` по PID-у, `pkill`, и подобные привилегированные/широкоразрушающие команды без явной просьбы пользователя.
- Никогда не используй force-флаги (`--force`, `-f`, `--no-verify`, `--hard`, `--all`) если они не указаны пользователем явно. Если pre-commit hook упал — чини проблему, а не обходи hook.
- Перед `rm` / `mv` / перезаписью файлов сначала проверь пути через `ls`. Никогда не выполняй `rm -rf $VAR/...`, если переменная может быть пустой.
- Всегда оборачивай пути в кавычки, если в них могут быть пробелы или спецсимволы.
- Используй абсолютные пути или `cwd`-параметр инструмента; не полагайся на скрытое состояние shell между командами.
- Предпочитай специализированные инструменты (Read, Edit, Write, Grep, Glob) shell-командам (`cat`, `sed`, `awk`, `echo > file`). Это безопаснее и читаемее в логе.
- Долгие команды (build, lint, test, миграции) запускай с разумным timeout и в background, если они блокируют сессию; не используй `sleep` для опроса — лучше один раз дождаться завершения.
- Перед `kill`/остановкой процесса проверь через `ps`/`lsof`, что это именно тот процесс, и убедись, что не убьёшь что-то полезное пользователя.
- Не запускай продакшн-команды (реальные торговые операции, прод-миграции, force-close в проде, очистка БД) ни при каких обстоятельствах без явной просьбы.
- Не выполняй сетевые операции (push, pull, fetch внешних ресурсов, обращения к биржам) без необходимости задачи. Биржевые API могут требовать ключи и совершать реальные сделки.

### 11.2 Destructive commands — только по явной просьбе

Никогда не запускай без прямого запроса пользователя:

- `git reset --hard`, `git checkout -- <file>`, `git restore .`, `git clean -fd`, `git push --force`, `git branch -D`.
- `rm -rf`, `rm` для важных или непонятных путей, удаление целых директорий.
- Удаление веток (локальных или remote), удаление stash-ей.
- `git rebase` / `git merge` с автоматическим разрешением конфликтов, если пользователь не запросил.
- Удаление миграций, удаление .env-файлов, удаление lock-файлов (`pnpm-lock.yaml`, `poetry.lock`).
- Destructive DB операции: `DROP`, `TRUNCATE`, `DELETE` без `WHERE`, `--noinput`-flush, `flush`, `migrate --fake-initial`.
- Реальные торговые команды: запуск bot-engine в `real` режиме, force-close активных сделок, manual orders на биржах.
- Запись реальных exchange API keys или production-токенов в `.env`. Правка `.env` для согласования non-secret конфигурации сервисов разрешена и описана в §10.1.

Если такая команда нужна для задачи — сначала объясни, что она делает и какие последствия, и подожди подтверждения.

### 11.3 Что делать, если команда не выполняется

Если команда не может быть выполнена из-за окружения, sandbox-ограничений или отсутствия зависимостей, сообщи:

- какая команда;
- почему не выполнена (network, permissions, отсутствует tool, и т.д.);
- что нужно сделать пользователю, чтобы выполнить её самостоятельно;
- как это влияет на уверенность в результате (например: "build не прогонял, типы могли разъехаться").

Не маскируй неудачу: лучше явно отметить, что проверка не пройдена, чем тихо отправить непроверенный код.

## 12. Git и чужие изменения

- В репозитории могут быть незакоммиченные изменения пользователя.
- Перед изменениями проверяй `git status --short`, если задача затрагивает файлы.
- Не откатывай файлы, которые сам не менял.
- Если рядом есть чужие изменения, работай поверх них аккуратно.
- Не делай commit/push/PR без явной просьбы.

## 13. Как добавлять кодовые комментарии

Комментарии нужны только там, где они объясняют:

- неочевидный контракт;
- side effect;
- риск;
- workaround конкретной биржи/API;
- concurrency/retry/recovery поведение;
- формулу или бизнес-правило.

Комментарии не должны пересказывать очевидный код.

Язык комментариев: только английский.

## 14. Definition of Done

Задача считается завершенной, когда:

- код изменен в нужной области без лишнего refactor;
- релевантный `DOCS.md` обновлен, если поведение или контракт изменились;
- доступные проверки выполнены или честно описано, почему не выполнены;
- итоговый ответ на русском кратко перечисляет изменения, проверки и ограничения;
- нет незакрытых long-running процессов, запущенных для задачи.

## 15. Когда сомневаешься

Если есть риск реальной торговли, удаления данных, изменения security модели или нарушения API контракта:

1. Остановись.
2. Сформулируй риск.
3. Предложи безопасный вариант.
4. Спроси подтверждение, если действие потенциально destructive или может повлиять на реальные сделки.

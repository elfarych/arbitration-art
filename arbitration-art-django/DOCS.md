# Arbitration Art Django Backend - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние проекта `arbitration-art-django`: структуру, настройки, модели, API, интеграции, команды запуска и важные инженерные замечания. Это не пользовательский README, а рабочая карта проекта для быстрого восстановления контекста.

## 1. Краткое резюме

`arbitration-art-django` - Django/DRF backend для Arbitration Art. Проект хранит пользователей, настройки арбитражных ботов, runtime-конфиги standalone trader, эмуляционные сделки и реальные сделки. Пользовательские API работают через JWT, а service-to-service записи и recovery защищены общим `X-Service-Token`.

Основные роли backend:

- Аутентификация пользователей через Simple JWT.
- Хранение пользовательских API-ключей бирж в модели `UserExchangeKeys`, включая MEXC.
- CRUD настроек ботов `BotConfig` с привязкой к владельцу и server-managed `service_url`.
- CRUD `TraderRuntimeConfig` для управляемого из Django standalone `arbitration-trader`.
- Хранение ошибок `TraderRuntimeConfigError`, которые standalone `arbitration-trader` отправляет в Django через service-token API.
- Inline lifecycle-команды к bot-engine из ViewSet (`POST`/`PATCH`/`DELETE`/`force-close`), с возвратом 502 при недоступном engine и сохранённым `sync_status=FAILED` для retry. Для standalone trader runtime config сохранён прежний сигнальный путь через `transaction.on_commit`.
- Хранение истории эмуляционных сделок `EmulationTrade`.
- Хранение истории реальных сделок `Trade` с привязкой к `owner`, `bot` и/или `runtime_config`. `opened_at` фиксируется engine-ом в момент fill-а, а не в момент DB write.
- Django admin для ручного просмотра и редактирования основных сущностей.

Текущие приложения:

- `apps.users` - кастомная модель пользователя, exchange keys, auth API.
- `apps.bots` - настройки ботов, runtime-конфиги standalone trader, сделки, lifecycle sync, API.

## 2. Технологический стек

Фактические зависимости:

- Python 3.12.6 в локальном `venv`.
- Django 6.0.x.
- Django REST Framework 3.17.x.
- djangorestframework-simplejwt 5.5.x.
- django-cors-headers 4.9.x.
- django-environ 0.13.x.
- psycopg 3.x для PostgreSQL.
- gunicorn в production requirements.
- django-debug-toolbar и ipython в development requirements.

Файлы зависимостей:

- `requirements/base.txt` - базовые runtime-зависимости.
- `requirements/development.txt` - базовые + dev tools.
- `requirements/production.txt` - базовые + gunicorn.
- `requirements.txt` - pinned freeze текущего окружения.

Важно: `development.py` задает БД строго через `env.db("DATABASE_URL")`. Дефолтная dev-БД — dockerized PostgreSQL из `docker-compose.yml` (`make db-up`); `.env` и `.env.example` указывают `DATABASE_URL` на этот контейнер.

## 3. Структура проекта

```text
arbitration-art-django/
├── manage.py
├── .env
├── .env.example
├── README.md
├── DOCS.md
├── requirements.txt
├── requirements/
│   ├── base.txt
│   ├── development.txt
│   └── production.txt
├── arbitration_art_django/
│   ├── __init__.py
│   ├── urls.py
│   ├── wsgi.py
│   ├── asgi.py
│   └── settings/
│       ├── __init__.py
│       ├── base.py
│       ├── development.py
│       └── production.py
└── apps/
    ├── __init__.py
    ├── users/
    │   ├── models.py
    │   ├── admin.py
    │   ├── apps.py
    │   ├── api/
    │   │   ├── urls.py
    │   │   ├── views.py
    │   │   └── serializers.py
    │   └── migrations/
    └── bots/
        ├── models.py
        ├── admin.py
        ├── apps.py
        ├── api/
        │   ├── urls.py
        │   ├── views.py
        │   └── serializers.py
        └── migrations/
```

Сгенерированные/локальные директории:

- `venv/` - локальное виртуальное окружение.
- `staticfiles/` - собранная статика Django admin/DRF.
- `__pycache__/` - Python cache.

## 4. Settings и окружения

### 4.1. Точки входа

`manage.py` выставляет дефолтный settings module:

```text
DJANGO_SETTINGS_MODULE=arbitration_art_django.settings.development
```

ASGI/WSGI модули:

- `arbitration_art_django/asgi.py`
- `arbitration_art_django/wsgi.py`

URL root:

- `arbitration_art_django.urls`

### 4.2. `settings/base.py`

Общие настройки:

- `BASE_DIR` указывает на корень `arbitration-art-django`.
- Конфигурация читается через `django-environ`.
- `.env` читается из `BASE_DIR / ".env"`.
- `SECRET_KEY` обязателен.
- `AUTH_USER_MODEL = "users.User"`.
- `LANGUAGE_CODE` и `TIME_ZONE` берутся из env.
- `STATIC_ROOT = BASE_DIR / "staticfiles"`.
- `MEDIA_ROOT = BASE_DIR / "media"`.

Installed apps:

- Django core apps: admin, auth, contenttypes, sessions, messages, staticfiles.
- Third-party: `rest_framework`, `rest_framework_simplejwt`, `rest_framework_simplejwt.token_blacklist`, `corsheaders`.
- Local: `apps.users`, `apps.bots`.

Middleware:

- `SecurityMiddleware`
- `CorsMiddleware`
- sessions/common/csrf/auth/messages/clickjacking

DRF defaults:

- Authentication: JWT only (`JWTAuthentication`).
- Permission: `IsAuthenticated` by default.
- Pagination: `PageNumberPagination`.
- Page size: `20`.
- Renderer: JSON only in base.

Simple JWT:

- Access token lifetime: 30 minutes.
- Refresh token lifetime: 7 days.
- Refresh rotation enabled.
- Blacklist after rotation enabled.
- Auth header type: `Bearer`.

### 4.3. `settings/development.py`

Development overrides:

- `DEBUG = True`.
- `ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]`.
- `DATABASES["default"] = env.db("DATABASE_URL")`.
- `CORS_ALLOW_ALL_ORIGINS = True`.
- Adds DRF browsable API renderer.
- `EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"`.

Практический вывод: для локального запуска нужен `.env` с `DATABASE_URL`, либо settings надо расширить дефолтом.

### 4.4. `settings/production.py`

Production overrides:

- `DEBUG = False`.
- `ALLOWED_HOSTS` читается из env.
- `DATABASES["default"] = env.db("DATABASE_URL")`.
- `CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])`.
- Security hardening:
  - `SECURE_BROWSER_XSS_FILTER = True`
  - `SECURE_CONTENT_TYPE_NOSNIFF = True`
  - `X_FRAME_OPTIONS = "DENY"`
  - `SECURE_SSL_REDIRECT` по умолчанию `True`
  - `SESSION_COOKIE_SECURE = True`
  - `CSRF_COOKIE_SECURE = True`
  - HSTS: 31536000 секунд, include subdomains, preload

Проверка `manage.py check --deploy --settings=arbitration_art_django.settings.production` показала одно предупреждение по текущему локальному `SECRET_KEY`: ключ слишком слабый/похож на development secret. Для production нужен длинный случайный секрет.

## 5. Переменные окружения

Шаблон в `.env.example`:

```text
SECRET_KEY=...
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1
POSTGRES_USER=arbitration_art
POSTGRES_PASSWORD=arbitration_art_dev_pass
POSTGRES_DB=arbitration_art
POSTGRES_HOST_PORT=5434
DATABASE_URL=postgres://arbitration_art:arbitration_art_dev_pass@localhost:5434/arbitration_art
LANGUAGE_CODE=ru
TIME_ZONE=Asia/Almaty
# CORS_ALLOWED_ORIGINS=https://your-frontend-domain.com
# SECURE_SSL_REDIRECT=True
```

Переменные `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_HOST_PORT` читаются `docker-compose.yml` для контейнера БД. `DATABASE_URL` должен указывать на тот же кластер. Если меняешь креды/порт — синхронизируй обе части.

Фактически важные переменные:

| Переменная | Где используется | Обязательность | Комментарий |
|---|---|---:|---|
| `SECRET_KEY` | base settings | да | Не должен попадать в git. Для prod нужен сильный случайный ключ. |
| `DATABASE_URL` | development/production | да | Сейчас без дефолта в settings. В dev указывает на dockerized PostgreSQL (по умолчанию `localhost:5434`). |
| `POSTGRES_USER` | docker-compose | да для dev | Пользователь PostgreSQL для dockerized БД. |
| `POSTGRES_PASSWORD` | docker-compose | да для dev | Пароль PostgreSQL для dockerized БД. |
| `POSTGRES_DB` | docker-compose | да для dev | Имя БД для dockerized PostgreSQL. |
| `POSTGRES_HOST_PORT` | docker-compose | нет | Host port для проброса PostgreSQL. Дефолт `5434`. |
| `ALLOWED_HOSTS` | production | да для prod | В development захардкожен список localhost. |
| `LANGUAGE_CODE` | base | нет | Дефолт env-схемы: `ru`. |
| `TIME_ZONE` | base | нет | Дефолт env-схемы: `Asia/Almaty`. |
| `CORS_ALLOWED_ORIGINS` | production | нет | Список origin-ов frontend в prod. |
| `SECURE_SSL_REDIRECT` | production | нет | Дефолт `True`. |
| `SERVICE_SHARED_TOKEN` | Django -> trader/bot-engine | да для service calls | Shared token для запросов между Django и runtime-сервисами. Без него `is_service_request` всегда False, и engine не сможет писать trade-ы в Django. |
| `BOT_ENGINE_SERVICE_URL_DEFAULT` | base | нет | Дефолтный `service_url` для новых `BotConfig`. Это поле read-only через API, что закрывает SSRF-вектор «юзер шлёт ключи на свой произвольный host». Поле остаётся в БД для multi-engine deployment-ов через admin. |
| `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` | Django -> bot-engine | нет | Дефолт `30`. Используется для START/STOP/FORCE-CLOSE, которым нужен запас на `loadMarkets`, `setIsolatedMargin`, `setLeverage`. |
| `SERVICE_SYNC_TIMEOUT_SECONDS` | Django -> bot-engine | нет | Дефолт `5`. Используется для SYNC: in-memory edit на стороне engine должен возвращаться за миллисекунды. |
| `SERVICE_REQUEST_TIMEOUT_SECONDS` | Django -> arbitration-trader (legacy) | нет | Дефолт `30`. Используется только клиентом standalone trader runtime info; для bot-engine используются split-таймауты выше. |
| `SERVICE_REQUEST_RETRIES` | Django -> trader/bot-engine | нет | Количество retry для service-request. Применимо ко всем service-calls. |
| `SERVICE_REQUEST_RETRY_DELAY_SECONDS` | Django -> trader/bot-engine | нет | Пауза между retry service-request. |

Не копировать реальные значения `.env` в документацию, логи, issues или PR.

## 6. URL routing

Root URL config: `arbitration_art_django/urls.py`.

Глобальные маршруты:

| Prefix | Назначение |
|---|---|
| `/admin/` | Django admin |
| `/api/auth/` | Auth/profile endpoints из `apps.users.api.urls` |
| `/api/bots/` | Bot/trade endpoints из `apps.bots.api.urls`, включая агрегированный PnL `GET /api/bots/pnl/` (см. §9.6) |

## 7. Пользователи и auth

### 7.1. Модель `User`

Файл: `apps/users/models.py`.

`User` наследуется от `django.contrib.auth.models.AbstractUser`.

Отличия от стандартного пользователя:

- `email` переопределен как `unique=True`.
- `USERNAME_FIELD = "email"` - логин по email.
- `REQUIRED_FIELDS = ["username"]` - username нужен при `createsuperuser`.
- `ordering = ["-date_joined"]`.
- `__str__` возвращает email.

Сохраняются стандартные поля `AbstractUser`: `username`, `first_name`, `last_name`, `is_active`, `is_staff`, `is_superuser`, `last_login`, `date_joined`, группы/permissions и т.д.

### 7.2. Модель `UserExchangeKeys`

Файл: `apps/users/models.py`.

Назначение: хранить API-ключи бирж пользователя.

Поля:

| Поле | Тип | Комментарий |
|---|---|---|
| `user` | `OneToOneField(User)` | `related_name="exchange_keys"`, cascade delete. |
| `binance_api_key` | `CharField(255, blank=True)` | Binance API key. |
| `binance_secret` | `CharField(255, blank=True)` | Binance secret. |
| `bybit_api_key` | `CharField(255, blank=True)` | Bybit API key. |
| `bybit_secret` | `CharField(255, blank=True)` | Bybit secret. |
| `gate_api_key` | `CharField(255, blank=True)` | Gate API key. |
| `gate_secret` | `CharField(255, blank=True)` | Gate secret. |
| `mexc_api_key` | `CharField(255, blank=True)` | MEXC API key. |
| `mexc_secret` | `CharField(255, blank=True)` | MEXC secret. |

Важное замечание: в текущем коде ключи хранятся обычным текстом в БД. Для production это высокий риск. Минимально нужно ограничить доступ к БД/admin, лучше добавить шифрование на уровне поля или secret storage.

Модель сейчас не зарегистрирована в `apps/users/admin.py`. Authenticated user управляет своими ключами через `/api/auth/exchange-keys/`. API не возвращает сырые значения ключей и secrets: GET возвращает только флаги наличия и masked previews. PATCH принимает новые значения и обновляет только переданные поля; пустая строка очищает конкретное поле.

Профильные тест-эндпоинты (`/api/auth/exchange-keys/<exchange>/test-connection/` и `/test-trade/`) реализованы как тонкий прокси: `apps/users/services/exchange_tester.py` достаёт сырые ключи из `UserExchangeKeys`, добавляет `X-Service-Token` через `apps/bots/services/trader_runtime_shared.service_headers` и POST'ит на `BOT_ENGINE_SERVICE_URL_DEFAULT + /engine/exchange/...`. Это гарантирует, что валидация ключей проходит через тот же exchange-клиент, который engine использует в живой торговле. Read-only `test-connection` ретраится по политике `SERVICE_REQUEST_RETRIES`; `test-trade` отправляется **без ретраев**, потому что повтор может привести ко второй реальной сделке при сетевой ошибке после фактической отправки ордера.

### 7.3. User serializer

`UserSerializer` возвращает только read-only профиль:

```text
id
email
username
first_name
last_name
date_joined
```

Все поля read-only.

`UserExchangeKeysSerializer` используется для текущего пользователя:

- write-only поля: `binance_api_key`, `binance_secret`, `bybit_api_key`, `bybit_secret`, `gate_api_key`, `gate_secret`, `mexc_api_key`, `mexc_secret`;
- GET representation сгруппирован по биржам `binance`, `bybit`, `gate`, `mexc`;
- каждая биржа возвращает `has_api_key`, `has_secret`, `api_key_preview`, `secret_preview`;
- serializer не возвращает сырые secret values.

### 7.4. Auth API

Prefix: `/api/auth/`.

| Method | Path | View | Permission | Назначение |
|---|---|---|---|---|
| `POST` | `/api/auth/login/` | `TokenObtainPairView` | public | Получить `access` и `refresh` по email/password. |
| `POST` | `/api/auth/refresh/` | `TokenRefreshView` | public | Обновить access token через refresh token. |
| `POST` | `/api/auth/logout/` | `LogoutView` | authenticated | Blacklist переданного refresh token. |
| `GET` | `/api/auth/me/` | `MeView` | authenticated | Получить профиль текущего пользователя. |
| `GET` | `/api/auth/exchange-keys/` | `ExchangeKeysView` | authenticated | Получить masked состояние API-ключей текущего пользователя. |
| `PATCH` | `/api/auth/exchange-keys/` | `ExchangeKeysView` | authenticated | Обновить или очистить API-ключи текущего пользователя. |
| `POST` | `/api/auth/exchange-keys/<exchange>/test-connection/` | `ExchangeKeyTestConnectionView` | authenticated | Прокси на `engine /engine/exchange/test-connection`. Проверяет ключи через `loadMarkets` + `fetchPositions(['SOL/USDT:USDT'])`. |
| `POST` | `/api/auth/exchange-keys/<exchange>/test-trade/` | `ExchangeKeyTestTradeView` | authenticated | Прокси на `engine /engine/exchange/test-trade`. Запускает round-trip SOL/USDT futures-сделку с notional $15 и плечом 10x (≈ $1.5 маржи) и возвращает per-leg latency в ms. |

Login использует стандартный Simple JWT serializer. Так как `USERNAME_FIELD = "email"`, ожидаемый credential field - `email`.

Пример login request:

```json
{
  "email": "user@example.com",
  "password": "password"
}
```

Пример login response:

```json
{
  "refresh": "...",
  "access": "..."
}
```

Logout request:

```json
{
  "refresh": "..."
}
```

Logout behavior:

- Если `refresh` отсутствует, ответ `400 {"detail": "Refresh token is required."}`.
- Если refresh невалиден/истек, ответ `400 {"detail": "Invalid or expired token."}`.
- Если успешно, ответ `204 No Content`.

## 8. Bots domain

Файл моделей: `apps/bots/models.py`.

Общие definitions exchange choices вынесены на модульный уровень:

- `BOT_EXCHANGE_CHOICES` для `BotConfig`, `EmulationTrade` и `Trade`;
- `TRADER_EXCHANGE_CHOICES` для `TraderRuntimeConfig`.

### 8.1. `BotConfig`

Назначение: конфигурационная карточка арбитражного бота.

Связи:

- `owner -> settings.AUTH_USER_MODEL`
- `related_name="bot_configs"`
- `on_delete=models.CASCADE`

Choices:

`Exchange`:

- `binance_futures` - Binance Futures
- `bybit_futures` - Bybit Futures
- `gate_futures` - Gate Futures
- `mexc_futures` - Mexc Futures

`OrderType`:

- `buy` - Покупка
- `sell` - Продажа
- `auto` - Авто

`TradeMode`:

- `emulator` - Эмулятор
- `real` - Реальная торговля

Поля:

| Поле | Тип | Default | Комментарий |
|---|---|---:|---|
| `owner` | FK User | - | Владелец конфигурации. |
| `primary_exchange` | `CharField(50, choices=Exchange)` | - | Основная биржа. |
| `secondary_exchange` | `CharField(50, choices=Exchange)` | - | Вторичная биржа. |
| `entry_spread` | `DecimalField(10, 4)` | - | Спред входа. |
| `exit_spread` | `DecimalField(10, 4)` | - | Спред выхода. |
| `coin` | `CharField(20)` | - | Монета/символ. |
| `coin_amount` | `DecimalField(18, 8)` | - | Размер позиции в монете. |
| `order_type` | `CharField(4, choices=OrderType)` | `auto` | Направление/режим ордера. |
| `trade_mode` | `CharField(20, choices=TradeMode)` | `emulator` | Эмуляция или реальная торговля. |
| `max_trades` | `PositiveIntegerField` | `10` | Максимум сделок, которые бот может **открыть за всё время жизни** (`open + closed + force_closed`). Enforce'ится в engine (`BotTrader`): in-memory счётчик гидрируется из Django на `start()` через `GET /bots/trades/?bot_id=N&page_size=1` (читается `count` пагинатора). Источник истины — Django; счётчик переживает engine restart. Сброс — удалить и пересоздать бот, либо поднять значение через PATCH. `0` (если кто-то ручкой выставит) трактуется как «без лимита». |
| `primary_leverage` | `PositiveIntegerField` | `1` | Плечо на основной бирже. |
| `secondary_leverage` | `PositiveIntegerField` | `1` | Плечо на вторичной бирже. |
| `trade_on_primary_exchange` | `BooleanField` | `True` | Торговать ли на primary leg. |
| `trade_on_secondary_exchange` | `BooleanField` | `True` | Торговать ли на secondary leg. |
| `max_trade_duration_seconds` | `PositiveIntegerField` | `3600` | Максимальная длительность сделки в секундах. Сериализатор форсит `min_value=10` (см. §api/serializers, `BotConfigSerializer`). Engine проверяет таймаут раз в `TIMEOUT_CHECK_INTERVAL_MS=2s`, так что нижняя граница 10s рабочая. Миграция `0020` переименовала поле из `_minutes` и умножила существующие значения на 60. |
| `max_leg_drawdown_percent` | `FloatField` | `80.0` | Максимальная просадка leg в процентах. |
| `min_trade_interval_seconds` | `PositiveIntegerField` | `10` | Минимальный интервал между сделками в секундах. Engine ставит cooldown ровно на это время после каждого `executeClose` (кроме `shutdown`-причины) и на всех error-путях `executeOpen`; следующая сделка не откроется раньше срока. `0` — gating отключён. Поле уходит в engine через `lifecycle.bot_payload`. |
| `is_active` | `BooleanField` | `True` | Активность бота. |
| `created_at` | `DateTimeField(auto_now_add)` | - | Дата создания. |
| `updated_at` | `DateTimeField(auto_now)` | - | Дата обновления. |

Meta:

- `ordering = ["-created_at"]`
- verbose names: `bot configuration`, `bot configurations`
- `CheckConstraint('bot_config_distinct_exchanges')`: `~Q(primary_exchange=F("secondary_exchange"))`. DB-level гарантия, что обе ноги конфигурируются на разные биржи; иначе engine подписался бы на один и тот же orderbook дважды и спред всегда был бы нулевым.

`__str__`:

```text
{coin} | {primary_exchange} -> {secondary_exchange}
```

### 8.2. `EmulationTrade`

Назначение: цикл исполнения эмулированной арбитражной сделки.

Связи:

- `bot -> BotConfig`
- `on_delete=models.SET_NULL`
- `related_name="emulation_trades"`
- `null=True, blank=True`

`bot = null` используется как scanner trade, не привязанный к пользовательскому боту.

Choices:

`Status`:

- `open`
- `closed`

Поля:

| Поле | Тип | Nullable | Комментарий |
|---|---|---:|---|
| `bot` | FK BotConfig | да | Бот или `null` для scanner trade. |
| `coin` | `CharField(50)` | да | Дублирует монету для историчности/сканера. |
| `primary_exchange` | choices `BOT_EXCHANGE_CHOICES` | да | Primary exchange. |
| `secondary_exchange` | choices `BOT_EXCHANGE_CHOICES` | да | Secondary exchange. |
| `order_type` | choices BotConfig.OrderType | да | buy/sell/auto. |
| `status` | choices Status | нет | Default `open`. |
| `amount` | `DecimalField(18, 8)` | нет | Размер сделки. |
| `primary_open_price` | `DecimalField(20, 8)` | нет | Цена открытия primary leg. |
| `secondary_open_price` | `DecimalField(20, 8)` | нет | Цена открытия secondary leg. |
| `open_spread` | `DecimalField(10, 4)` | нет | Спред открытия. |
| `opened_at` | `DateTimeField(auto_now_add)` | нет | Время открытия. |
| `primary_close_price` | `DecimalField(20, 8)` | да | Цена закрытия primary leg. |
| `secondary_close_price` | `DecimalField(20, 8)` | да | Цена закрытия secondary leg. |
| `close_spread` | `DecimalField(10, 4)` | да | Спред закрытия. |
| `profit_percentage` | `DecimalField(10, 4)` | да | Profit %. |
| `closed_at` | `DateTimeField` | да | Время закрытия. |

Meta:

- `ordering = ["-opened_at"]`
- Constraints:
  - `unique_open_emulation_trade_per_bot` — partial unique index `UNIQUE (bot) WHERE status = 'open'`. Гарантирует, что у одного бота не может быть больше одной активной эмуляционной сделки. Без этого index-а network-флап между engine и Django мог оставлять orphan-записи (POST дошёл, ответ — нет → engine открывал ещё одну параллельно). При повторном POST на занятый bot Django вернёт 400, engine ловит ошибку и через `findOrphanOpenTrade` подхватывает существующий row, не создавая дубль. Миграция `0021_unique_open_trade_per_bot` перед AddConstraint автоматически закрывает существующие orphan-дубликаты (оставляет самый свежий open, остальные → `closed`).

### 8.3. `Trade`

Назначение: цикл исполнения реальной арбитражной сделки на выбранных futures/derivatives биржах.

`Trade` привязывается к `owner` и ровно одному источнику исполнения: `bot` или `runtime_config`. Service-token request может писать реальные сделки, JWT-пользователь читает только свои сделки.

Choices:

`Status`:

- `open`
- `closed`
- `force_closed`

`CloseReason`:

- `profit`
- `timeout`
- `manual`
- `shutdown`
- `error`

Поля:

| Поле | Тип | Nullable | Комментарий |
|---|---|---:|---|
| `coin` | `CharField(50)` | нет | Монета. |
| `primary_exchange` | choices `BOT_EXCHANGE_CHOICES` | нет | Primary exchange. |
| `secondary_exchange` | choices `BOT_EXCHANGE_CHOICES` | нет | Secondary exchange. |
| `order_type` | choices BotConfig.OrderType | нет | buy/sell/auto. |
| `status` | choices Status | нет | Default `open`. |
| `close_reason` | choices CloseReason | да | Причина закрытия. |
| `amount` | `DecimalField(18, 8)` | нет | Размер позиции. |
| `leverage` | `PositiveIntegerField` | нет | Default `1`. |
| `primary_open_price` | `DecimalField(20, 8)` | нет | Фактическая open цена primary. |
| `secondary_open_price` | `DecimalField(20, 8)` | нет | Фактическая open цена secondary. |
| `primary_open_order_id` | `CharField(100)` | да | ID open ордера primary. |
| `secondary_open_order_id` | `CharField(100)` | да | ID open ордера secondary. |
| `open_spread` | `DecimalField(10, 4)` | нет | Спред открытия. |
| `open_commission` | `DecimalField(18, 6)` | нет | Total open commission в USDT, default `0`. Расширено до 18 знаков, чтобы вместить большие позиции high-leverage. |
| `opened_at` | `DateTimeField(default=timezone.now)` | нет | Время фактического fill-а на бирже, передаётся engine-ом. До production-readiness рефакторинга было `auto_now_add` и фиксировало момент DB write, теперь — момент фактического открытия. |
| `primary_close_price` | `DecimalField(20, 8)` | да | Close цена primary. |
| `secondary_close_price` | `DecimalField(20, 8)` | да | Close цена secondary. |
| `primary_close_order_id` | `CharField(100)` | да | ID close ордера primary. |
| `secondary_close_order_id` | `CharField(100)` | да | ID close ордера secondary. |
| `close_spread` | `DecimalField(10, 4)` | да | Спред закрытия. |
| `close_commission` | `DecimalField(18, 6)` | да | Total close commission в USDT. Расширено до 18 знаков. |
| `profit_usdt` | `DecimalField(18, 6)` | да | Profit в USDT. Расширено до 18 знаков, чтобы вместить high-leverage экстремумы. |
| `profit_percentage` | `DecimalField(10, 4)` | да | Profit %. |
| `closed_at` | `DateTimeField` | да | Время закрытия. |

Meta:

- `ordering = ["-opened_at"]`
- Constraints:
  - `CheckConstraint('trade_single_runtime_source')` — запрещает одновременную привязку и к `bot`, и к `runtime_config`.
  - `unique_open_trade_per_bot` — partial unique index `UNIQUE (bot) WHERE status = 'open' AND bot IS NOT NULL`. Bot-owned trades должны быть уникальны по active-открытию (как `EmulationTrade`). `runtime_config`-owned trades не покрыты: для трейдер-рантайма max-concurrent контролируется в самом сервисе. Миграция `0021_unique_open_trade_per_bot` подчищает legacy-дубликаты (старые → `status='closed'`, `close_reason='error'`) перед AddConstraint.

## 9. Bots API

Prefix: `/api/bots/`.

Роутер: `DefaultRouter` в `apps/bots/api/urls.py`.

Регистрации:

```python
router.register("trades", EmulationTradeViewSet, basename="bot-trades")
router.register("real-trades", TradeViewSet, basename="real-trades")
router.register("runtime-config-errors", TraderRuntimeConfigErrorViewSet, basename="trader-runtime-config-errors")
router.register("runtime-configs", TraderRuntimeConfigViewSet, basename="trader-runtime-config")
# Standalone path declared before the empty-prefix BotConfigViewSet, иначе
# роутер интерпретирует `pnl` как pk у BotConfig.retrieve.
urlpatterns = [
    path("pnl/", PnlSummaryView.as_view(), name="bots-pnl-summary"),
]
router.register("", BotConfigViewSet, basename="bot-config")
urlpatterns += router.urls
```

Из-за регистрации пустого prefix для `BotConfigViewSet` endpoints конфигураций находятся прямо под `/api/bots/`. Standalone `path("pnl/", ...)` обязательно объявлять до `router.register("", ...)`, иначе DRF попытается распарсить `pnl` как `BotConfig.pk`.

### 9.1. `BotConfigViewSet`

Класс: `apps.bots.api.views.BotConfigViewSet`.

Тип: `ModelViewSet`.

Permissions: явно не заданы, поэтому используется global DRF default `IsAuthenticated`.

Queryset:

```python
BotConfig.objects.filter(owner=self.request.user)
```

То есть пользователь видит и меняет только свои bot configs.

Endpoints:

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/bots/` | Список bot configs текущего пользователя. |
| `POST` | `/api/bots/` | Создать bot config. Если `is_active=true`, ViewSet синхронно вызывает engine START и возвращает 502 при ошибке. |
| `GET` | `/api/bots/{id}/` | Получить bot config текущего пользователя. |
| `PUT` | `/api/bots/{id}/` | Полностью обновить bot config. Inline lifecycle: START если активен, STOP при выходе из is_active=True. |
| `PATCH` | `/api/bots/{id}/` | Частично обновить bot config. То же поведение, что и PUT. |
| `DELETE` | `/api/bots/{id}/` | Сначала inline STOP (если бот активен), потом удаление. 502 без удаления, если engine не подтвердил остановку. |
| `POST` | `/api/bots/{id}/force-close/` | Inline FORCE-CLOSE через engine. |
| `GET` | `/api/bots/{id}/engine-health/` | Probe engine `/health` для service_url этого бота. 502 если engine недоступен. Side effect-free. |
| `GET` | `/api/bots/engine-bootstrap/?service_url=<self>` | Service-only (`X-Service-Token`). Возвращает `{ "bots": [<runtime_payload>, ...] }` для всех `BotConfig` с `is_active=True` и `service_url=<self>`. Engine дёргает endpoint при старте, чтобы восстановить in-memory traders после крэша. Фильтр по `service_url` нужен для multi-engine setup-а — каждый engine получает только своих ботов. `runtime_payload` идентичен полезной нагрузке `/engine/bot/start` (тот же `build_bot_runtime_payload`), включая `keys`. |

Serializer fields (`BotConfigSerializer`):

```text
id
service_url
primary_exchange
secondary_exchange
entry_spread
exit_spread
coin
coin_amount
order_type
trade_mode
max_trades
primary_leverage
secondary_leverage
trade_on_primary_exchange
trade_on_secondary_exchange
max_trade_duration_seconds
max_leg_drawdown_percent
min_trade_interval_seconds
is_active
status
sync_status
last_command
last_sync_error
last_synced_at
created_at
updated_at
```

Read-only:

```text
id
service_url
status
sync_status
last_command
last_sync_error
last_synced_at
created_at
updated_at
```

`owner` не принимается из API, выставляется из `request.user` в `perform_create`. `service_url` read-only через API: дефолт берётся из `settings.BOT_ENGINE_SERVICE_URL_DEFAULT`. Это закрывает SSRF-вектор: иначе аутентифицированный пользователь мог бы PATCH-нуть свой `service_url` на attacker-host и получить туда payload с собственными биржевыми ключами.

Дополнительные валидаторы:

- `coin` — должен соответствовать ccxt USDT-margined формату `^[A-Z0-9]{1,20}/USDT:USDT$` (например `BTC/USDT:USDT`); неверный формат отклоняется на этапе validation, иначе engine стартует, но никогда не найдёт пару в orderbook.
- `coin_amount > 0`.
- `primary_exchange != secondary_exchange` (плюс DB-level `CheckConstraint`).
- Если `is_active=true` и `trade_mode=real`, хотя бы одна из ног (`trade_on_primary_exchange`/`trade_on_secondary_exchange`) должна быть включена.
- Поля `trade_mode`, `primary_exchange`, `secondary_exchange`, `primary_leverage`, `secondary_leverage` запрещено менять, пока бот активен. Для смены нужно сначала `is_active=false` (engine закроет позиции и сбросит trader), потом изменить поле, потом `is_active=true` (engine стартует новый trader с правильной margin/leverage конфигурацией).
- При `is_active=true` и `trade_mode=real` сериалайзер проверяет, что у `owner.exchange_keys` непустые `api_key` + `secret` для каждой ноги, которая будет торговать (`trade_on_primary_exchange`/`trade_on_secondary_exchange`). Маппинг `binance_futures → binance` и т.д. (см. `_EXCHANGE_KEY_PREFIX`) держится в синхроне с `Engine.extractKeys` и фронтовым `EXCHANGE_KEY_PREFIX` в `BotFormDialog.vue`. Без ключей сериалайзер отдаёт `400` с указанием конкретной биржи, вместо непрозрачного `502` от engine.

Side effects (inline, без `transaction.on_commit`):

- `POST` `is_active=true` → `sync_bot_lifecycle(START)`. На fail — 502, запись остаётся в БД с `sync_status=FAILED`, `last_sync_error` заполнен, можно ретраить через PATCH.
- `POST` `is_active=false` → engine call не выполняется (бот создан как pre-staged).
- `PUT`/`PATCH` (стал активным или остался активным) → `START` (engine идемпотентен: START уже запущенного трейдера эквивалентен SYNC). Это же путь используется для возобновления после pause: при `is_active: False → True` engine получает START и через `Engine.startBot` → `syncBot` флипает `is_active=true` без teardown/reconnect; уже-открытая сделка продолжает закрываться по своим условиям.
- `PUT`/`PATCH` (был активен, стал неактивен) → `PAUSE`. Engine оставляет трейдер в памяти, останавливает открытие новых сделок (через `bot.is_active=false` в синканутом конфиге), но `checkExit`/`checkTimeouts` продолжают мониторить активную сделку и закроют её по profit / timeout / max-leg drawdown. **Pause не закрывает позиции.** Чтобы закрыть сделку немедленно — `force-close` (бот остаётся активным) или последовательно pause+force-close. Чтобы полностью убрать трейдер из engine — DELETE (за бот стоп с закрытием).
- `PUT`/`PATCH` (был и остался неактивным) → engine не дёргается.
- `DELETE` (активный) → синхронный `STOP` (`Engine.stopBot` закрывает active trade с reason `shutdown` и удаляет трейдер из `Engine.traders`) + delete row; 502 без delete, если engine не подтвердил.
- `DELETE` (неактивный) → просто delete row.
- `force-close` → синхронный `FORCE-CLOSE`. Если `bot.is_active=False`, action отвечает `409 Conflict` без вызова engine — у engine нет in-memory trader-а для неактивного бота, и команда была бы no-op с misleading-2xx. Если хочешь принудительно закрыть сделку у паузнутого бота — сначала сними паузу (PATCH is_active=true), engine.startBot подцепит open trade через restoreOpenTrades, потом дёрни force-close.

Сигнальный путь `bot_config_pre_delete` остаётся как safety net для admin/cascade удалений: если активный бот удалён без прохождения через ViewSet (например, при cascade-delete пользователя), сигнал шлёт best-effort `STOP` на engine. В нормальном flow inline `STOP` уже отработал, и signal видит `is_active=False` (in-memory мутация в `destroy`) и пропускает дубль.

Пример create request:

```json
{
  "primary_exchange": "binance_futures",
  "secondary_exchange": "bybit_futures",
  "entry_spread": "0.5000",
  "exit_spread": "0.1000",
  "coin": "BTC/USDT:USDT",
  "coin_amount": "0.01000000",
  "order_type": "auto",
  "trade_mode": "emulator",
  "max_trades": 10,
  "primary_leverage": 1,
  "secondary_leverage": 1,
  "trade_on_primary_exchange": true,
  "trade_on_secondary_exchange": true,
  "max_trade_duration_seconds": 3600,
  "max_leg_drawdown_percent": 80.0,
  "min_trade_interval_seconds": 10,
  "is_active": true
}
```

### 9.2. `TraderRuntimeConfigViewSet`

Класс: `apps.bots.api.views.TraderRuntimeConfigViewSet`.

Тип: `ModelViewSet`.

Permissions:

```python
permission_classes = [IsAuthenticated]
```

Queryset:

```python
TraderRuntimeConfig.objects.filter(owner=request.user, is_deleted=False)
```

Если передан `?include_archived=true`, queryset включает архивные конфиги.

Endpoints:

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/bots/runtime-configs/` | Список runtime-конфигов текущего пользователя. |
| `POST` | `/api/bots/runtime-configs/` | Создать runtime-конфиг текущего пользователя. |
| `GET` | `/api/bots/runtime-configs/{id}/` | Получить runtime-конфиг. |
| `PUT` | `/api/bots/runtime-configs/{id}/` | Полностью обновить runtime-конфиг. |
| `PATCH` | `/api/bots/runtime-configs/{id}/` | Частично обновить runtime-конфиг. |
| `DELETE` | `/api/bots/runtime-configs/{id}/` | Архивировать runtime-конфиг и отправить `stop`, если runtime считался активным. |
| `GET` | `/api/bots/runtime-configs/{id}/active-payload/` | Service-token endpoint для startup-запроса `arbitration-trader`; возвращает полный runtime payload только если конфиг активен и не архивирован. |
| `GET` | `/api/bots/runtime-configs/{id}/exchange-health/` | Проверить доступность primary/secondary бирж по API-ключам через `arbitration-trader`. |
| `GET` | `/api/bots/runtime-configs/{id}/active-coins/` | Получить набор монет, по которым активный runtime держит открытые сделки. |
| `GET` | `/api/bots/runtime-configs/{id}/open-trades-pnl/` | Получить live PnL по текущим открытым сделкам активного runtime. |
| `GET` | `/api/bots/runtime-configs/{id}/system-load/` | Получить текущую нагрузку CPU/RAM на сервере `arbitration-trader`. |
| `GET` | `/api/bots/runtime-configs/{id}/server-info/` | Получить hostname и IP-адреса сервера `arbitration-trader`. |
| `POST` | `/api/bots/runtime-configs/{id}/test-trade/` | Запустить изолированную XRPUSDT open/close сделку через runtime service и вернуть latency metrics. |

Serializer fields:

```text
id
name
service_url
primary_exchange
secondary_exchange
use_testnet
trade_amount_usdt
leverage
max_concurrent_trades
top_liquid_pairs_count
max_trade_duration_minutes
max_leg_drawdown_percent
open_threshold
close_threshold
orderbook_limit
chunk_size
is_active
status
sync_status
last_command
last_sync_error
last_synced_at
is_deleted
archived_at
created_at
updated_at
```

Read-only:

```text
id
status
sync_status
last_command
last_sync_error
last_synced_at
is_deleted
archived_at
created_at
updated_at
```

Поведение create/update:

- `owner` всегда выставляется из `request.user`.
- На `POST /api/bots/runtime-configs/` serializer принудительно сохраняет `is_active=false`, даже если клиент прислал `true`.
- При создании с `is_active=false` post-save сигнал не отправляет lifecycle-команду в `arbitration-trader`.
- Первый lifecycle-запрос появляется только после явного включения runtime-конфига через update.
- Diagnostic actions реализованы в `apps.bots.api.views.TraderRuntimeConfigViewSet`, HTTP proxy-логика вынесена в `apps.bots.services.trader_runtime_info`.
- `active-payload` доступен только по `X-Service-Token`, использует `TraderRuntimeConfig.id` из URL и нужен для autostart `arbitration-trader` после перезапуска процесса. Если конфиг неактивен или архивирован, endpoint возвращает `204`.
- `top_liquid_pairs_count` передается в runtime payload как количество symbols, выбираемых торговым сервисом по абсолютному 24h price change на обеих биржах.
- Django ходит в runtime service с тем же `X-Service-Token`, что и lifecycle-команды; retry/timeout управляются `SERVICE_REQUEST_RETRIES`, `SERVICE_REQUEST_TIMEOUT_SECONDS`, `SERVICE_REQUEST_RETRY_DELAY_SECONDS`. Timeout по умолчанию `90` секунд, чтобы запуск runtime service с загрузкой рынков, сверкой позиций и websocket bootstrap не считался зависшим.
- Diagnostic endpoints `exchange-health`, `active-coins`, `open-trades-pnl`, `system-load` и `server-info` проксируются на compatibility routes runtime service с prefix `/engine/trader/runtime/...`.
- `exchange-health` отправляет полный runtime payload вместе с ключами пользователя и не зависит от того, активен ли сейчас runtime в процессе `arbitration-trader`.
- `active-coins` и `open-trades-pnl` читают только текущий active runtime внутри `arbitration-trader`; если запрошенный `runtime_config_id` не совпадает с активным, сервис возвращает пустой набор и `is_requested_runtime_active=false`.
- `system-load` возвращает system-wide метрики хоста `arbitration-trader` плюс `active_runtime_config_id` для сопоставления с текущим runtime.
- `server-info` возвращает `hostname`, primary non-internal IPv4 в `server_ip` и список non-internal IPv4 адресов в `ip_addresses`; endpoint нужен frontend для отображения IP торгового сервера.
- `test-trade` доступен для testnet и live runtime configs. Django отправляет полный runtime payload в `POST {service_url}/runtime/test-trade`, а торговый сервис использует `use_testnet` для выбора testnet или live биржевых endpoints. Optional body поддерживает `amount_usdt`; если runtime service недоступен или возвращает ошибку, Django отвечает `502`.
- Response `test-trade` содержит `success`, `symbol`, `exchange_symbol`, `amount_usdt`, `quantity`, общие метрики `detection_to_open_finished_ms`, `close_submit_to_close_finished_ms`, `total_ms`, а также per-exchange метрики Binance/Bybit для open/close ACK, fill-seen, order IDs и errors.

### 9.3. `TraderRuntimeConfigErrorViewSet`

Класс: `apps.bots.api.views.TraderRuntimeConfigErrorViewSet`.

Тип: `ModelViewSet`.

Permissions:

```python
permission_classes = [ServiceTokenWriteOrAuthenticatedRead]
```

Назначение: хранит ошибки runtime-конфигов standalone `arbitration-trader`.

Модель: `apps.bots.models.TraderRuntimeConfigError`.

Поля:

| Поле | Тип | Назначение |
|---|---|---|
| `runtime_config` | `ForeignKey(TraderRuntimeConfig)` | Runtime-конфиг, к которому относится ошибка. |
| `error_type` | `CharField(50)` | Тип ошибки: `start`, `sync`, `stop`, `runtime`, `exchange_health`, `diagnostics`, `validation`, `control_plane`. |
| `error_text` | `TextField` | Текст ошибки от `arbitration-trader`. |
| `created_at` | `DateTimeField(auto_now_add=True)` | Время создания записи. |

Queryset:

- service-token request видит все записи;
- authenticated user видит только ошибки своих `TraderRuntimeConfig`;
- anonymous request получает пустой queryset.

Filtering:

- `?runtime_config_id=<id>`
- `?error_type=<type>`

Endpoints:

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/bots/runtime-config-errors/` | Список ошибок runtime-конфигов. |
| `POST` | `/api/bots/runtime-config-errors/` | Создать ошибку через service-token request от `arbitration-trader`. |
| `GET` | `/api/bots/runtime-config-errors/{id}/` | Получить ошибку. |
| `PUT` | `/api/bots/runtime-config-errors/{id}/` | Полное обновление через service-token request. |
| `PATCH` | `/api/bots/runtime-config-errors/{id}/` | Частичное обновление через service-token request. |
| `DELETE` | `/api/bots/runtime-config-errors/{id}/` | Удаление через service-token request. |

Serializer fields:

```text
id
runtime_config
error_type
error_text
created_at
```

Read-only:

```text
id
created_at
```

Записи создаются `arbitration-trader` через `POST /api/bots/runtime-config-errors/` с header `X-Service-Token`. JWT-пользователи используют endpoint только для чтения своих ошибок.

### 9.4. `EmulationTradeViewSet`

Класс: `apps.bots.api.views.EmulationTradeViewSet`.

Тип: `ModelViewSet`.

Permissions:

```python
permission_classes = [ServiceTokenWriteOrAuthenticatedRead]
```

Queryset behavior:

- Authenticated user sees:
  - trades where `bot__owner = request.user`
  - plus scanner trades where `bot IS NULL`
- Anonymous user sees:
  - only scanner trades where `bot IS NULL`

Filtering:

- `?status=open`
- `?status=closed`

Endpoints:

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/bots/trades/` | Список эмуляционных сделок с учетом auth/scanner logic. |
| `POST` | `/api/bots/trades/` | Создать эмуляционную сделку. |
| `GET` | `/api/bots/trades/{id}/` | Получить сделку. |
| `PUT` | `/api/bots/trades/{id}/` | Полное обновление. |
| `PATCH` | `/api/bots/trades/{id}/` | Частичное обновление. |
| `DELETE` | `/api/bots/trades/{id}/` | Удаление. |

Serializer fields:

```text
id
bot
coin
primary_exchange
secondary_exchange
order_type
status
amount
primary_open_price
secondary_open_price
open_spread
primary_close_price
secondary_close_price
close_spread
profit_percentage
opened_at
closed_at
```

Read-only:

```text
id
opened_at
```

Write methods доступны только request-ам с `X-Service-Token`. JWT-пользователи используют endpoint для чтения своих записей.

### 9.5. `TradeViewSet`

Класс: `apps.bots.api.views.TradeViewSet`.

Тип: `ModelViewSet`.

Permissions:

```python
permission_classes = [ServiceTokenWriteOrAuthenticatedRead]
```

Queryset:

```python
Trade.objects.select_related("owner", "bot", "runtime_config")
```

Queryset behavior:

- service-token request видит все записи;
- authenticated user видит только сделки, где `owner = request.user`;
- anonymous request получает пустой queryset.

Filtering:

- `?status=open`
- `?status=closed`
- `?status=force_closed`

Endpoints:

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/bots/real-trades/` | Список реальных сделок. |
| `POST` | `/api/bots/real-trades/` | Создать реальную сделку. |
| `GET` | `/api/bots/real-trades/{id}/` | Получить реальную сделку. |
| `PUT` | `/api/bots/real-trades/{id}/` | Полное обновление. |
| `PATCH` | `/api/bots/real-trades/{id}/` | Частичное обновление. |
| `DELETE` | `/api/bots/real-trades/{id}/` | Удаление. |

Serializer fields:

```text
id
coin
primary_exchange
secondary_exchange
order_type
status
close_reason
amount
leverage
primary_open_price
secondary_open_price
primary_open_order_id
secondary_open_order_id
open_spread
open_commission
opened_at
primary_close_price
secondary_close_price
primary_close_order_id
secondary_close_order_id
close_spread
close_commission
profit_usdt
profit_percentage
closed_at
```

Read-only:

```text
id
owner
```

`opened_at` writable на POST так что engine записывает фактическое время fill-а (не время DB write). Поскольку POST доступен только с `X-Service-Token`, конечный пользователь подделать `opened_at` не может. `bot` и `runtime_config` запрещены к смене на PATCH (валидируется в `TradeSerializer.validate`), чтобы трейд нельзя было перепривязать к другому боту после открытия. Write methods доступны только request-ам с `X-Service-Token`. JWT-пользователи используют endpoint для чтения своих реальных сделок.

### 9.6. `PnlSummaryView`

Класс: `apps.bots.api.views.PnlSummaryView` (DRF `APIView`).

Endpoint: `GET /api/bots/pnl/`.

Permissions: `IsAuthenticated`.

Назначение: агрегированный отчёт по реализованному PnL текущего пользователя — для виджета «PnL за сегодня» в шапке, чипа лайфтайм-PnL на `BotCard` и страницы `/pnl` во фронте.

Логика собрана в `apps/bots/services/pnl.py::aggregate_pnl`. Только закрытые сделки (`closed_at IS NOT NULL`, `status IN (closed, force_closed)` для `Trade`, `status = closed` для `EmulationTrade`, `profit_*` не NULL).

Query параметры (все опциональны):

| Param | Тип | Семантика |
|---|---|---|
| `from` | ISO 8601 datetime | Нижняя граница `closed_at` (включительно). Принимает суффикс `Z`. |
| `to` | ISO 8601 datetime | Верхняя граница `closed_at` (включительно). |
| `bot_id` | int | Ограничить агрегацию одним ботом. |
| `trade_mode` | `real` \| `emulator` | Без параметра учитываются оба режима. |

Источник USDT:

- `Trade.profit_usdt` — authoritative, считается engine через `calculateRealPnL` после fill-ов и докомпенсируется фактической комиссией в `BotTrader`-е.
- `EmulationTrade.profit_usdt` не хранится. Сервис аннотирует выражением `profit_percentage * amount * LEAST(primary_open_price, secondary_open_price) / 100`. Это обратное преобразование от `capital = amount * min(open prices)`, которое engine использует в `calculateRealPnL`. Эмуляция не платит комиссию, поэтому процент уже соответствует капиталу.

Формат ответа:

```json
{
  "from": "2026-05-01T00:00:00+05:00",
  "to": "2026-05-15T23:59:59.999000+05:00",
  "total": {
    "profit_usdt": "12.345600",
    "trades_count": 17,
    "wins": 11,
    "losses": 6,
    "win_rate": 64.71
  },
  "real": { "profit_usdt": "10.123400", "trades_count": 10, "wins": 7, "losses": 3 },
  "emulator": { "profit_usdt": "2.222200", "trades_count": 7, "wins": 4, "losses": 3 },
  "by_bot": [
    {
      "bot_id": 5,
      "coin": "BTC/USDT:USDT",
      "trade_mode": "real",
      "primary_exchange": "binance_futures",
      "secondary_exchange": "bybit_futures",
      "is_active": true,
      "profit_usdt": "5.340000",
      "trades_count": 5,
      "wins": 3,
      "losses": 2,
      "real": { "profit_usdt": "5.340000", "trades_count": 5, "wins": 3, "losses": 2 },
      "emulator": { "profit_usdt": "0.000000", "trades_count": 0, "wins": 0, "losses": 0 }
    }
  ]
}
```

Сортировка `by_bot` — по `abs(profit_usdt) DESC`. Сделки с `bot_id IS NULL` (бот был удалён) попадают только в `total`, в `by_bot` не выводятся.

Кэш отсутствует: engine PATCH-ит закрытие сразу после fill-а, и любой кэш заметно задерживал бы виджет «PnL за сегодня». При росте объёма сделок добавить индекс на `(owner_id, closed_at)` и `(bot__owner_id, closed_at)` в миграции; на текущих объёмах простой `closed_at__gte`-фильтр обходится без него.

## 10. Интеграция с bot-engine

Файлы:

- `apps/bots/services/lifecycle.py` — orchestration: построение payload, вызовы engine, обновление sync metadata.
- `apps/bots/services/trader_runtime_shared.py` — общие хелперы (URL join, service headers, filtered exchange keys).
- `apps/bots/api/views.py` — ViewSet методы вызывают lifecycle inline.

URL берётся из `BotConfig.service_url` per-record. Дефолт — `settings.BOT_ENGINE_SERVICE_URL_DEFAULT`. Поле read-only через API, чтобы пользователь не мог перенаправить payload с собственными ключами на чужой host.

Service token прокидывается обратной стороной: Django шлёт `X-Service-Token` в каждом запросе к engine, engine валидирует его в `preHandler` и отвергает чужие запросы (engine также шлёт этот токен обратно в Django при записи trade-ов).

### Payload

`_bot_runtime_payload(bot)` для START/SYNC:

```json
{
  "bot_id": 123,
  "owner_id": 7,
  "config": {
    "id": 123,
    "primary_exchange": "binance_futures",
    "secondary_exchange": "bybit_futures",
    "entry_spread": "0.5000",
    "exit_spread": "0.1000",
    "coin": "BTC/USDT:USDT",
    "coin_amount": "0.01000000",
    "order_type": "auto",
    "trade_mode": "real",
    "primary_leverage": 5,
    "secondary_leverage": 5,
    "trade_on_primary_exchange": true,
    "trade_on_secondary_exchange": true,
    "max_trade_duration_seconds": 3600,
    "max_leg_drawdown_percent": 80.0,
    "min_trade_interval_seconds": 10,
    "is_active": true
  },
  "keys": {
    "binance_api_key": "...",
    "binance_secret": "...",
    "bybit_api_key": "...",
    "bybit_secret": "..."
  }
}
```

`keys` содержит **только пары для бирж этого бота** (primary + secondary). `exchange_keys_for_user(user, exchanges=(primary, secondary))` фильтрует по prefix-имени биржи (`binance_futures` → `binance`). Лишние ключи не отправляются — это снижает surface при отладке/логировании.

Для STOP/FORCE-CLOSE отправляется минимальный payload:

```json
{ "bot_id": 123 }
```

### Action mapping и timeouts

| Django событие | Engine action | URL | Timeout |
|---|---|---|---|
| Create bot, is_active=true | `start` | `POST {service_url}/engine/bot/start` | `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` (default 30s) |
| Update bot, остаётся активным или становится активным | `start` (идемпотентен в engine) | `POST {service_url}/engine/bot/start` | `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` |
| Update bot, был активен → стал неактивен (pause) | `pause` | `POST {service_url}/engine/bot/pause` | `SERVICE_SYNC_TIMEOUT_SECONDS` (default 5s) |
| Delete bot (активный) | `stop` | `POST {service_url}/engine/bot/stop` | `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` |
| Force close | `force-close` | `POST {service_url}/engine/bot/force-close` | `SERVICE_LIFECYCLE_TIMEOUT_SECONDS` |
| Engine health probe (read-only) | (GET) | `GET {service_url}/health` | `SERVICE_SYNC_TIMEOUT_SECONDS` (default 5s) |
| Engine bootstrap (engine → Django, read-only) | (GET) | `GET /api/bots/engine-bootstrap/?service_url=<self>` | client timeout 15s (`api.ts`) |

Engine bootstrap — pull-направление: при старте engine сам зовёт Django, чтобы восстановить in-memory traders для всех `is_active=True` ботов с матчащимся `service_url`. Это закрывает класс ситуаций «engine рестартанул, Django считает ботов running, но они фактически стоят». Open trades восстанавливает уже существующий `BotTrader.restoreOpenTrades` внутри `Engine.startBot`. Endpoint защищён `ServiceTokenOnly` permission — без валидного `X-Service-Token` возвращает 403.

START заменяет SYNC потому что [`Engine.startBot`](../arbitration-bot-engine/src/classes/Engine.ts) **идемпотентен**: если bot_id уже зарегистрирован, он форвардит конфиг существующему trader-у через `syncConfig`. Это убирает класс багов «бот не стартует после re-activate, потому что Django шлёт SYNC, а engine не имеет trader-а в памяти».

### Failure handling

Lifecycle sync **inline** в `BotConfigViewSet.perform_create` / `perform_update` / `destroy`. На `LifecycleSyncError`:

- `perform_create` / `perform_update` оборачивают в `EngineSyncError` (502 Bad Gateway). Запись в БД создаётся/обновляется (поэтому юзер не теряет конфиг), `sync_status=FAILED`, `last_sync_error` заполнен с детальным сообщением. Юзер может ретраить через повторный PATCH.
- `destroy` отказывается удалять row, возвращает 502 с текстом ошибки. После того как engine станет доступен, юзер ретраит DELETE.

Сигнал `bot_config_pre_delete` остаётся как fallback для admin/cascade-deletion, делает best-effort STOP и проглатывает ошибки (нельзя ронять cascade-delete).

### Engine response contract

Engine отвечает `{ success: true }` или `{ success: false, error: "..." }` со статусом 200/500. `_perform_post` бросает `LifecycleSyncError` на любой non-2xx ответ и на network errors; retry-policy: `SERVICE_REQUEST_RETRIES` попыток с паузой `SERVICE_REQUEST_RETRY_DELAY_SECONDS`.

## 11. Django admin

### 11.1. Users admin

`apps/users/admin.py`.

Зарегистрирована только модель `User`.

Список:

- `email`
- `username`
- `is_active`
- `is_staff`
- `date_joined`

Фильтры:

- `is_active`
- `is_staff`
- `is_superuser`

Поиск:

- `email`
- `username`
- `first_name`
- `last_name`

Ordering:

- `-date_joined`

`UserExchangeKeys` в admin не зарегистрирована.

### 11.2. BotConfig admin

Список:

- `id`
- `owner`
- `coin`
- `primary_exchange`
- `secondary_exchange`
- `order_type`
- `is_active`
- `created_at`

Фильтры:

- `is_active`
- `order_type`
- `primary_exchange`

Поиск:

- `coin`
- `owner__email`

Readonly:

- `created_at`
- `updated_at`

### 11.3. EmulationTrade admin

Список:

- `id`
- `bot`
- `status`
- `amount`
- `open_spread`
- `close_spread`
- `profit_percentage`
- `opened_at`
- `closed_at`

Фильтры:

- `status`
- `bot__coin`

Поиск:

- `bot__coin`
- `status`

Readonly:

- `opened_at`
- `closed_at`

### 11.4. Trade admin

Список:

- `id`
- `coin`
- `order_type`
- `status`
- `close_reason`
- `amount`
- `leverage`
- `open_spread`
- `profit_usdt`
- `profit_percentage`
- `opened_at`
- `closed_at`

Фильтры:

- `status`
- `close_reason`
- `order_type`
- `primary_exchange`

Поиск:

- `coin`

Readonly:

- `opened_at`

Fieldsets:

- Base trade data.
- Open details.
- Close details.

### 11.5. Что не регистрируется в admin

- `TraderRuntimeConfig` / `TraderRuntimeConfigError` — out of scope §3.0 (`arbitration-trader`), регистрации в `apps/bots/admin.py` нет.
- `rest_framework_simplejwt.token_blacklist.BlacklistedToken` и `OutstandingToken` — снимаются с регистрации в `apps/users/admin.py` через `admin.site.unregister(...)`. Сам app `rest_framework_simplejwt.token_blacklist` остаётся в `INSTALLED_APPS`, потому что `SIMPLE_JWT.BLACKLIST_AFTER_ROTATION=True` опирается на его модели и сигналы — удаляется только admin-поверхность.

## 12. Миграции и состояние БД

Проверено 2026-04-22:

- `venv/bin/python manage.py showmigrations` успешно подключился к локальной PostgreSQL БД при запуске вне sandbox.
- Все миграции Django core, `token_blacklist`, `users` и `bots` применены.
- Последняя миграция `users`: `0002_userexchangekeys`.
- Последняя миграция `bots`: `0014_botconfig_max_leg_drawdown_percent_and_more`.
- `venv/bin/python manage.py makemigrations --check --dry-run` -> `No changes detected`.

Миграционная история `bots` показывает, что модель активно развивалась:

- начальная `BotConfig`;
- изменения exchange choices;
- временные поля ticks были добавлены и затем удалены;
- добавлена `EmulationTrade`;
- добавлены snapshot-поля trade metadata;
- добавлена `Trade`;
- добавлен `trade_mode`;
- добавлены flags торговли по primary/secondary;
- добавлены duration/drawdown limits.

## 13. Рабочие команды

### 13.0. Запуск одной командой (Docker + Makefile)

Локальная PostgreSQL поднимается через `docker-compose.yml`, остальной workflow — через `Makefile`.

Структура файлов:

- `docker-compose.yml` — сервис `postgres` (image `postgres:16-alpine`), named volume `arbitration_art_postgres_data`, healthcheck по `pg_isready`. Host port читается из `POSTGRES_HOST_PORT` (дефолт `5434`, чтобы не конфликтовать с локальной БД на `5432` и другими dev-контейнерами на `5433`).
- `Makefile` — оркестрирует Docker, venv, deps, миграции и dev server.

Поднять всё одной командой (БД + venv + deps + миграции + dev server):

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-art-django
make start
```

Полезные таргеты:

| Команда | Назначение |
|---|---|
| `make start` | Поднять Postgres, поставить deps, накатить миграции, запустить runserver. |
| `make up` | То же, что `make start`, но без runserver (полезно для CI/scripted setup). |
| `make db-up` | Поднять только Postgres и дождаться healthcheck. |
| `make db-down` | Остановить контейнер. Данные в volume сохраняются. |
| `make db-reset` | **Destructive.** Снести контейнер вместе с volume — БД обнулится. Запускать только по явной задаче. |
| `make db-logs` | `docker compose logs -f postgres`. |
| `make db-shell` | `psql` в контейнер от имени `POSTGRES_USER`. |
| `make migrate` | `manage.py migrate`. |
| `make makemigrations` | `manage.py makemigrations`. |
| `make check` | `manage.py check`. |
| `make superuser` | `manage.py createsuperuser` (interactive). |
| `make runserver` | Только dev server (без подъёма БД). |

Makefile подтягивает `./.env`, поэтому `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/`POSTGRES_HOST_PORT` и `DATABASE_URL` живут в одном месте.

Ограничения:

- Требуется Docker Desktop запущенный. Если daemon не поднят, `make db-up` упадёт с понятной ошибкой.
- Если host port уже занят (например другим dev-контейнером Postgres), переопределить через `POSTGRES_HOST_PORT` в `.env` и не забыть синхронно поправить порт в `DATABASE_URL`.
- Makefile создаёт `venv` только если его нет; существующий venv не пересоздаётся.

### 13.1. Ручные команды

Из корня проекта:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-art-django
```

Активировать окружение:

```bash
source venv/bin/activate
```

Проверить Python:

```bash
venv/bin/python --version
```

Установить зависимости:

```bash
venv/bin/pip install -r requirements/development.txt
```

Проверить Django config:

```bash
venv/bin/python manage.py check
```

Проверить production warnings:

```bash
venv/bin/python manage.py check --deploy --settings=arbitration_art_django.settings.production
```

Проверить, нужны ли миграции:

```bash
venv/bin/python manage.py makemigrations --check --dry-run
```

Создать миграции:

```bash
venv/bin/python manage.py makemigrations
```

Применить миграции:

```bash
venv/bin/python manage.py migrate
```

Посмотреть статус миграций:

```bash
venv/bin/python manage.py showmigrations
```

Создать суперпользователя:

```bash
venv/bin/python manage.py createsuperuser
```

Запустить dev server:

```bash
venv/bin/python manage.py runserver
```

Альтернатива после `source venv/bin/activate`:

```bash
python manage.py runserver
```

В текущем shell вне venv команда `python` отсутствовала, поэтому без активации использовать `venv/bin/python`.

### 13.2. Production-сборка (Docker / Dokploy)

Production-образ строится из самого каталога `arbitration-art-django/`. Артефакты:

- `Dockerfile` — `python:3.13-slim` + `libpq5` (psycopg[binary] свою libpq везёт сам, build toolchain не нужен). Ставит `requirements/production.txt` (включает `gunicorn`). `ENV DJANGO_SETTINGS_MODULE=arbitration_art_django.settings.production` зашит в образе, чтобы `manage.py` и WSGI читали одни и те же settings без флагов.
- `entrypoint.sh` — порядок старта: `migrate --noinput` → `collectstatic --noinput` → `gunicorn`. Bind на `0.0.0.0:8000`, число воркеров через `GUNICORN_WORKERS` (дефолт `3`), access/error логи в stdout/stderr.
- `.dockerignore` — режет `venv/`, `.env*` (кроме `.env.example`), `staticfiles/`, `media/`, `.git/`, `DOCS.md`, `docker-compose.yml` и кеши. Это нужно, чтобы dev `.env` и venv не попадали в образ.

Build context для Dokploy:

- В Dokploy указать **Build Path** = корень репозитория, **Dockerfile Path** = `arbitration-art-django/Dockerfile`, **Build Context** = `arbitration-art-django/`. Альтернатива — подключать к Dokploy только подкаталог `arbitration-art-django/` как отдельный source.
- Контейнер слушает порт `8000` — пробрасывать через Traefik/обратный прокси Dokploy.

Обязательные env vars в Dokploy (без них контейнер не стартует):

- `SECRET_KEY` — production-секрет, длинный и случайный (`openssl rand -hex 32`). Не переиспользовать dev-значение.
- `ALLOWED_HOSTS` — список доменов через запятую (`django-environ` парсит как list).
- `DATABASE_URL` — `postgres://user:pass@host:5432/dbname`. БД должна быть доступна из сети Dokploy (managed Postgres или соседний сервис в том же проекте).
- `SERVICE_SHARED_TOKEN` — должен совпадать с тем же значением в `arbitration-bot-engine`.
- `BOT_ENGINE_SERVICE_URL_DEFAULT` — URL engine-сервиса для новых `BotConfig`.

Опциональные (есть дефолты в `base.py`):

- `CORS_ALLOWED_ORIGINS` — origin фронтенда (`https://...`); без него API недоступен из браузера.
- `CSRF_TRUSTED_ORIGINS` — список origin-ов с схемой (`https://...`) для CSRF-валидации POST-форм за TLS-терминирующим прокси. Обязателен для `/admin/login/` и любой формы admin, когда Django стоит за Traefik. Без него Django 4+ отдаёт 403 на POST.
- `SECURE_SSL_REDIRECT` — дефолт `True`. См. риски ниже.
- `LANGUAGE_CODE`, `TIME_ZONE`, `SERVICE_*_TIMEOUT_SECONDS`, `GUNICORN_WORKERS`.

Reverse proxy / HTTPS termination:

`production.py` ставит `SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO","https")` и `USE_X_FORWARDED_HOST=True`. Это критично для Dokploy/Traefik: без этой настройки Django видит входящий запрос как HTTP, `SECURE_SSL_REDIRECT=True` отдаёт 301 на HTTPS, прокси заворачивает обратно в HTTP — и получается бесконечный редирект (`ERR_TOO_MANY_REDIRECTS`). Прокси обязан перезаписывать `X-Forwarded-Proto` на каждом входящем запросе и не пропускать клиентский заголовок (Traefik делает это по умолчанию). Если меняете прокси на менее доверенный — снимите `SECURE_PROXY_SSL_HEADER`, иначе клиент сможет подделать «secure».

Риски и подводные камни при деплое за reverse proxy:

- **Static files.** Раздачей `/static/` занимается **WhiteNoise** (middleware подключён в `base.py` сразу после `SecurityMiddleware`). `STORAGES["staticfiles"]` = `whitenoise.storage.CompressedManifestStaticFilesStorage` — `collectstatic` пишет в `/app/staticfiles` хешированные копии с gzip/brotli, WhiteNoise отдаёт их прямо из gunicorn-процесса с длинным `Cache-Control: immutable`. Никакой внешний nginx перед Django **не нужен**, Traefik работает только как TLS-терминатор. Если когда-то понадобится — `STORAGES["staticfiles"]` можно переключить на не-manifest вариант, чтобы избежать `collectstatic` failure при сломанных `url()` ссылках в сторонних app-ах.
- **Медиа.** Пользовательских загрузок в продукте сейчас нет; `MEDIA_ROOT` остаётся локальной директорией внутри контейнера. Если они появятся — нужен volume mount или S3-совместимое хранилище, WhiteNoise media не обслуживает (только static).
- **CSRF на admin login.** После исправления HTTPS-redirect-loop POST в `/admin/login/` упадёт 403, если в env не задан `CSRF_TRUSTED_ORIGINS=https://your-django-domain`. Включить туда все домены, по которым к Django ходят формы.
- **Контейнер не должен торчать наружу мимо Traefik.** В Dokploy убрать публикацию порта `8000` на публичный IP. Сервис должен быть доступен только через Traefik по домену. Иначе публичные сканеры (leakix, l9scan) долбятся напрямую по IP, обходя HTTPS и логи прокси.
- **Биржевые ключи и `.env`.** В образе должно быть пусто по части `.env` — секреты приходят через Dokploy env vars. Биржевые ключи в `.env` не кладём в любом случае (§10.1) — они живут в БД через `UserExchangeKeys`.
- **Engine на отдельном хосте.** Канал Django → engine по умолчанию HTTP с `X-Service-Token`. Если engine разворачивается на другом узле, держать его на private сети или терминировать TLS на прокси между сервисами.

Локальный smoke build (опционально):

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-art-django
docker build -t arbitration-art-django:local .
```

## 14. Проверки, выполненные во время анализа

Команды:

```bash
venv/bin/python --version
venv/bin/python manage.py check
venv/bin/python manage.py showmigrations
venv/bin/python manage.py makemigrations --check --dry-run
venv/bin/python manage.py check --deploy --settings=arbitration_art_django.settings.production
```

Результаты:

- Python: `3.12.6`.
- `manage.py check`: ошибок нет.
- `showmigrations`: все миграции применены.
- `makemigrations --check --dry-run`: изменений не найдено.
- `check --deploy`: одно предупреждение `security.W009` по слабому текущему `SECRET_KEY`.

## 15. Аутентификация и права доступа

Global DRF defaults:

- Все endpoints требуют JWT, если view явно не переопределяет permissions.
- Header:

```text
Authorization: Bearer <access_token>
```

Явные исключения:

- Auth login/refresh от Simple JWT публичные.
- `EmulationTradeViewSet`, `TradeViewSet` и `TraderRuntimeConfigErrorViewSet` разрешают write methods только по `X-Service-Token`; JWT-пользователи используют эти endpoints для чтения своих данных.

Права по сущностям:

| Сущность | API ownership |
|---|---|
| `User` | Только `/me/` для текущего пользователя. |
| `BotConfig` | Фильтрация по `owner=request.user`. |
| `EmulationTrade` | Service-token видит и пишет все записи; auth user видит свои bot trades; anonymous получает пустой queryset. |
| `Trade` | Service-token видит и пишет все записи; auth user видит сделки со своим `owner`; anonymous получает пустой queryset. |
| `TraderRuntimeConfigError` | Service-token видит и пишет все записи; auth user видит ошибки своих runtime-конфигов; anonymous получает пустой queryset. |

## 16. Пагинация и формат ответов

Global DRF pagination:

- Class: `PageNumberPagination`.
- Page size: `20`.

List responses обычно имеют DRF-формат:

```json
{
  "count": 100,
  "next": "http://...",
  "previous": null,
  "results": []
}
```

Development settings добавляет Browsable API renderer. Base/production оставляют JSON renderer.

## 17. Risks и known limitations

### 17.1. Plaintext exchange secrets

`UserExchangeKeys` хранит secrets в обычных `CharField`. Это наиболее критичный риск.

Mitigations, которые уже на месте:

- API endpoint `/api/auth/exchange-keys/` отдаёт только masked preview (`api_key_preview`, `secret_preview`), а POST/PATCH полей `write_only`.
- Lifecycle payload содержит ключи только для тех двух бирж, которые реально использует bot (filtered `exchange_keys_for_user(user, exchanges=...)`).
- `BotConfig.service_url` read-only через API, поэтому юзер не может перенаправить payload с ключами на свой host.

Что желательно добавить дополнительно:

- field-level encryption (например, `django-cryptography`) или KMS/secret manager;
- audit trail доступа к ключам;
- запретить вывод любых secret-полей в structured logs (сейчас обеспечивается тем, что engine логирует config без `keys`, но любое будущее логирование может нарушить).

### 17.2. Service-token write endpoints

`EmulationTradeViewSet`, `TradeViewSet` и `TraderRuntimeConfigErrorViewSet` используют общий `X-Service-Token` для write methods. Если токен утечёт, атакующий с network access сможет писать/читать service-level данные.

Mitigations, которые уже на месте:

- сравнение токена через `hmac.compare_digest` (timing-safe);
- запрос с пустым/несовпадающим токеном получает `is_service_request=False` (write methods → 403).

Что желательно добавить:

- HMAC-подпись payload + timestamp вместо bearer-токена для защиты от replay;
- network allowlist на reverse proxy;
- mTLS между Django и engine для confidentiality на untrusted сети.

### 17.3. Inline lifecycle sync

Lifecycle команды для BotConfig (`POST`/`PATCH`/`DELETE`/`force-close`) выполняются inline в ViewSet через `sync_bot_lifecycle`. На failure возвращается 502 с заполненным `last_sync_error`, запись в БД сохраняется в `sync_status=FAILED` — юзер видит ошибку сразу и может ретраить. Это убирает класс ситуаций «Django сохранил, engine не получил, операционная команда висит в неопределённом состоянии».

Side effects:

- POST/PATCH блокируется на время до `SERVICE_LIFECYCLE_TIMEOUT_SECONDS × SERVICE_REQUEST_RETRIES` (по умолчанию 30s × 3 = 90s максимум). Для downstream-операторов это норма, для UI желательно показывать spinner.
- DELETE отказывается удалить row при недоступном engine — это умышленно, чтобы не оставить orphan-позиции.

### 17.4. Нет тестов

В проекте не найдено `tests.py`, `tests/`, pytest config или Django TestCase. При изменениях сейчас опора только на `manage.py check`, ручные проверки и engine-side build.

Минимальный набор тестов для production:

- login по email;
- `/api/auth/me/`;
- logout blacklist behavior;
- owner scoping для `BotConfigViewSet`;
- inline lifecycle: create/update/delete вызывают нужный engine action; на mock engine failure возвращается 502;
- restricted-field guard в BotConfigSerializer (запрет смены trade_mode/leverage/exchange когда бот активен);
- coin format validator;
- anonymous/auth queryset behavior для `EmulationTradeViewSet`;
- bot_id фильтр для `TradeViewSet`;
- serializer validation для choices/decimal fields.

### 17.5. Multi-process duplication

In-process Engine защищает от race в пределах одного процесса (`Set<starting>` + `Map<traders>`). Если у пользователя запущено два engine-процесса на один и тот же Django, оба могут получить `start` для одного `bot_id` и параллельно открывать позиции. Mitigation: deployment должен запускать один engine на один Django либо ввести distributed lock (Redis lease, DB row lock на `BotConfig.runtime_owner_node_id`).

### 17.6. `Trade.opened_at` поведение

`Trade.opened_at` стало `default=timezone.now` (не `auto_now_add`). Engine передаёт фактический timestamp fill-а; если по какой-то причине не передал, Django использует время DB write. Это normal degradation, но `Trade.opened_at` тогда отстаёт от реальности на сетевой latency. В мониторинге проверять, что engine стабильно шлёт `opened_at` в payload.

### 17.7. README может расходиться с фактическим dev-flow

`.env.example` и `docker-compose.yml` описывают dockerized PostgreSQL как dev-БД, а `development.py` требует `DATABASE_URL` без дефолта. Если в репозитории сохранился старый README с упоминанием SQLite — обновить под актуальный flow (`make start`).

### 17.8. Production secret warning

`check --deploy` на текущем окружении выдает `security.W009`: текущий `SECRET_KEY` недостаточно сильный. Для production заменить через secret manager / env.

### 17.9. CORS и transport security между Django и engine

`production.py` ставит `SECURE_SSL_REDIRECT=True`, `SECURE_HSTS_SECONDS`, и т.д. для входящего трафика. Канал Django → engine идёт по HTTP (`http://127.0.0.1:3001` по умолчанию). При деплое engine на отдельный хост payload с ключами летит по plaintext — защищён только `X-Service-Token` в заголовке. Production deployment должен либо держать engine на localhost (рекомендуется), либо терминировать TLS на reverse proxy между Django и engine.

## 18. Быстрый flow API-клиента

1. Клиент логинится:

```http
POST /api/auth/login/
```

2. Получает `access` и `refresh`.

3. Все пользовательские bot endpoints вызывает с header:

```text
Authorization: Bearer <access>
```

4. Получает профиль:

```http
GET /api/auth/me/
```

5. Создает bot config:

```http
POST /api/bots/
```

6. Django сохраняет `BotConfig(owner=request.user)` и отправляет `POST /engine/bot/start` в engine.

7. При изменении bot config Django отправляет `POST /engine/bot/sync`.

8. При force close:

```http
POST /api/bots/{id}/force-close/
```

9. При logout клиент отправляет refresh token:

```http
POST /api/auth/logout/
```

## 19. Быстрый flow bot-engine

Предполагаемое поведение внешнего engine по текущему Django коду:

1. Получает `start` с полной конфигурацией и ключами.
2. Запускает или обновляет внутренний bot worker.
3. Получает `sync` при изменениях.
4. Если `is_active=false`, должен перестать открывать новые сделки, но сопровождать текущие до выхода.
5. Пишет эмуляционные сделки через `/api/bots/trades/`.
6. Пишет реальные сделки через `/api/bots/real-trades/`.
7. Получает `stop` перед удалением bot config.
8. Получает `force-close` для принудительного закрытия.

Документированного retry/ack протокола между Django и engine нет.

## 20. Рекомендованный порядок доработок

Если проект готовить к более надежной эксплуатации, порядок такой:

1. Закрыть write endpoints для `trades`/`real-trades` service authentication-ом.
2. Вынести `ENGINE_URL` и timeout в env.
3. Добавить structured logging вместо `print`.
4. Защитить `UserExchangeKeys`: encryption или secret manager.
5. Добавить API/admin для управления exchange keys, если это нужно продуктово.
6. Добавить тесты owner scoping и engine sync.
7. Добавить sync status/outbox для bot-engine.
8. Привязать `Trade` к `BotConfig` или owner, если real trades пользовательские.
9. Обновить README под фактический PostgreSQL/DATABASE_URL behavior.
10. Добавить CI: lint, Django check, makemigrations check, tests.

## 21. Минимальный smoke test после изменений

Перед коммитом backend-изменений:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-art-django
venv/bin/python manage.py check
venv/bin/python manage.py makemigrations --check --dry-run
```

Если нужна проверка БД:

```bash
venv/bin/python manage.py showmigrations
venv/bin/python manage.py migrate --plan
```

Если менялись production settings:

```bash
venv/bin/python manage.py check --deploy --settings=arbitration_art_django.settings.production
```

Если менялись API endpoints, вручную проверить:

- login;
- `/api/auth/me/`;
- `/api/bots/` list/create/update/delete;
- `/api/bots/{id}/force-close/`;
- `/api/bots/trades/?status=open`;
- `/api/bots/real-trades/?status=open`.

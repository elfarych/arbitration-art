# Arbitration Art Django Backend - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние проекта `arbitration-art-django`: структуру, настройки, модели, API, интеграции, команды запуска и важные инженерные замечания. Это не пользовательский README, а рабочая карта проекта для быстрого восстановления контекста.

## 1. Краткое резюме

`arbitration-art-django` - Django/DRF backend для Arbitration Art. Проект хранит пользователей, настройки арбитражных ботов, runtime-конфиги standalone trader, эмуляционные сделки и реальные сделки. Пользовательские API работают через JWT, а service-to-service записи и recovery защищены общим `X-Service-Token`.

Основные роли backend:

- Аутентификация пользователей через Simple JWT.
- Хранение пользовательских API-ключей бирж в модели `UserExchangeKeys`, включая MEXC.
- CRUD настроек ботов `BotConfig` с привязкой к владельцу и per-record `service_url`.
- CRUD `TraderRuntimeConfig` для управляемого из Django standalone `arbitration-trader`.
- Хранение ошибок `TraderRuntimeConfigError`, которые standalone `arbitration-trader` отправляет в Django через service-token API.
- Сигнальную синхронизацию lifecycle-команд с внешними runtime-сервисами через service layer и `transaction.on_commit(...)`.
- Хранение истории эмуляционных сделок `EmulationTrade`.
- Хранение истории реальных сделок `Trade` с привязкой к `owner` и источнику запуска (`bot` или `runtime_config`).
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

Важно: README говорит о дефолтном SQLite, но в текущем `development.py` база задается строго через `env.db("DATABASE_URL")`. Если `DATABASE_URL` не задан, Django не получит рабочую БД из settings.

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
# DATABASE_URL=postgres://user:password@localhost:5432/arbitration_art
LANGUAGE_CODE=ru
TIME_ZONE=Asia/Almaty
# CORS_ALLOWED_ORIGINS=https://your-frontend-domain.com
# SECURE_SSL_REDIRECT=True
```

Фактически важные переменные:

| Переменная | Где используется | Обязательность | Комментарий |
|---|---|---:|---|
| `SECRET_KEY` | base settings | да | Не должен попадать в git. Для prod нужен сильный случайный ключ. |
| `DATABASE_URL` | development/production | да | Сейчас без дефолта в settings. Локально используется PostgreSQL. |
| `ALLOWED_HOSTS` | production | да для prod | В development захардкожен список localhost. |
| `LANGUAGE_CODE` | base | нет | Дефолт env-схемы: `ru`. |
| `TIME_ZONE` | base | нет | Дефолт env-схемы: `Asia/Almaty`. |
| `CORS_ALLOWED_ORIGINS` | production | нет | Список origin-ов frontend в prod. |
| `SECURE_SSL_REDIRECT` | production | нет | Дефолт `True`. |

Не копировать реальные значения `.env` в документацию, логи, issues или PR.

## 6. URL routing

Root URL config: `arbitration_art_django/urls.py`.

Глобальные маршруты:

| Prefix | Назначение |
|---|---|
| `/admin/` | Django admin |
| `/api/auth/` | Auth/profile endpoints из `apps.users.api.urls` |
| `/api/bots/` | Bot/trade endpoints из `apps.bots.api.urls` |

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
| `max_trades` | `PositiveIntegerField` | `10` | Максимум сделок. |
| `primary_leverage` | `PositiveIntegerField` | `1` | Плечо на основной бирже. |
| `secondary_leverage` | `PositiveIntegerField` | `1` | Плечо на вторичной бирже. |
| `trade_on_primary_exchange` | `BooleanField` | `True` | Торговать ли на primary leg. |
| `trade_on_secondary_exchange` | `BooleanField` | `True` | Торговать ли на secondary leg. |
| `max_trade_duration_minutes` | `PositiveIntegerField` | `60` | Максимальная длительность сделки. |
| `max_leg_drawdown_percent` | `FloatField` | `80.0` | Максимальная просадка leg в процентах. |
| `is_active` | `BooleanField` | `True` | Активность бота. |
| `created_at` | `DateTimeField(auto_now_add)` | - | Дата создания. |
| `updated_at` | `DateTimeField(auto_now)` | - | Дата обновления. |

Meta:

- `ordering = ["-created_at"]`
- verbose names: `bot configuration`, `bot configurations`

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
| `open_commission` | `DecimalField(12, 6)` | нет | Total open commission в USDT, default `0`. |
| `opened_at` | `DateTimeField(auto_now_add)` | нет | Время открытия. |
| `primary_close_price` | `DecimalField(20, 8)` | да | Close цена primary. |
| `secondary_close_price` | `DecimalField(20, 8)` | да | Close цена secondary. |
| `primary_close_order_id` | `CharField(100)` | да | ID close ордера primary. |
| `secondary_close_order_id` | `CharField(100)` | да | ID close ордера secondary. |
| `close_spread` | `DecimalField(10, 4)` | да | Спред закрытия. |
| `close_commission` | `DecimalField(12, 6)` | да | Total close commission в USDT. |
| `profit_usdt` | `DecimalField(12, 6)` | да | Profit в USDT. |
| `profit_percentage` | `DecimalField(10, 4)` | да | Profit %. |
| `closed_at` | `DateTimeField` | да | Время закрытия. |

Meta:

- `ordering = ["-opened_at"]`

## 9. Bots API

Prefix: `/api/bots/`.

Роутер: `DefaultRouter` в `apps/bots/api/urls.py`.

Регистрации:

```python
router.register("trades", EmulationTradeViewSet, basename="bot-trades")
router.register("real-trades", TradeViewSet, basename="real-trades")
router.register("runtime-config-errors", TraderRuntimeConfigErrorViewSet, basename="trader-runtime-config-errors")
router.register("runtime-configs", TraderRuntimeConfigViewSet, basename="trader-runtime-config")
router.register("", BotConfigViewSet, basename="bot-config")
```

Из-за регистрации пустого prefix для `BotConfigViewSet` endpoints конфигураций находятся прямо под `/api/bots/`.

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
| `POST` | `/api/bots/` | Создать bot config для текущего пользователя. |
| `GET` | `/api/bots/{id}/` | Получить bot config текущего пользователя. |
| `PUT` | `/api/bots/{id}/` | Полностью обновить bot config. |
| `PATCH` | `/api/bots/{id}/` | Частично обновить bot config. |
| `DELETE` | `/api/bots/{id}/` | Удалить bot config. |
| `POST` | `/api/bots/{id}/force-close/` | Отправить force-close в bot-engine. |

Serializer fields:

```text
id
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
max_trade_duration_minutes
max_leg_drawdown_percent
is_active
created_at
updated_at
```

Read-only:

```text
id
created_at
updated_at
```

`owner` не принимается из API. Он всегда выставляется из `request.user` в `perform_create`.

Side effects:

- `POST /api/bots/` -> `sync_with_engine(bot, "start")`
- update -> `sync_with_engine(bot, "sync")`
- delete -> `sync_with_engine(instance, "stop")`, затем `instance.delete()`
- force-close -> `sync_with_engine(bot, "force-close")`

Пример create request:

```json
{
  "primary_exchange": "binance_futures",
  "secondary_exchange": "bybit_futures",
  "entry_spread": "0.5000",
  "exit_spread": "0.1000",
  "coin": "BTC",
  "coin_amount": "0.01000000",
  "order_type": "auto",
  "trade_mode": "emulator",
  "max_trades": 10,
  "primary_leverage": 1,
  "secondary_leverage": 1,
  "trade_on_primary_exchange": true,
  "trade_on_secondary_exchange": true,
  "max_trade_duration_minutes": 60,
  "max_leg_drawdown_percent": 80.0,
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
| `GET` | `/api/bots/runtime-configs/{id}/exchange-health/` | Проверить доступность primary/secondary бирж по API-ключам через `arbitration-trader`. |
| `GET` | `/api/bots/runtime-configs/{id}/active-coins/` | Получить набор монет, по которым активный runtime держит открытые сделки. |
| `GET` | `/api/bots/runtime-configs/{id}/open-trades-pnl/` | Получить live PnL по текущим открытым сделкам активного runtime. |
| `GET` | `/api/bots/runtime-configs/{id}/system-load/` | Получить текущую нагрузку CPU/RAM на сервере `arbitration-trader`. |
| `GET` | `/api/bots/runtime-configs/{id}/server-info/` | Получить hostname и IP-адреса сервера `arbitration-trader`. |

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
- Django ходит в `arbitration-trader` с тем же `X-Service-Token`, что и lifecycle-команды; retry/timeout управляются `SERVICE_REQUEST_RETRIES`, `SERVICE_REQUEST_TIMEOUT_SECONDS`, `SERVICE_REQUEST_RETRY_DELAY_SECONDS`.
- `exchange-health` отправляет полный runtime payload вместе с ключами пользователя и не зависит от того, активен ли сейчас runtime в процессе `arbitration-trader`.
- `active-coins` и `open-trades-pnl` читают только текущий active runtime внутри `arbitration-trader`; если запрошенный `runtime_config_id` не совпадает с активным, сервис возвращает пустой набор и `is_requested_runtime_active=false`.
- `system-load` возвращает system-wide метрики хоста `arbitration-trader` плюс `active_runtime_config_id` для сопоставления с текущим runtime.
- `server-info` возвращает `hostname`, primary non-internal IPv4 в `server_ip` и список non-internal IPv4 адресов в `ip_addresses`; endpoint нужен frontend для отображения IP торгового сервера.

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
opened_at
```

Write methods доступны только request-ам с `X-Service-Token`. JWT-пользователи используют endpoint для чтения своих реальных сделок.

## 10. Интеграция с bot-engine

Файл: `apps/bots/api/views.py`.

Константа:

```python
ENGINE_URL = "http://127.0.0.1:3001/engine/bot"
```

Функция `get_engine_payload(bot)` собирает payload:

```json
{
  "bot_id": 123,
  "config": {
    "...": "BotConfigSerializer(bot).data"
  },
  "keys": {
    "binance_api_key": "...",
    "binance_secret": "...",
    "bybit_api_key": "...",
    "bybit_secret": "...",
    "gate_api_key": "...",
    "gate_secret": "..."
  }
}
```

Если у пользователя нет `exchange_keys`, `keys` будет `{}`.

Функция `sync_with_engine(bot, action="sync")`:

- Собирает URL: `f"{ENGINE_URL}/{action}"`.
- Для `force-close` и `stop` отправляет:

```json
{
  "bot_id": 123
}
```

- Для остальных action отправляет полный payload с config и keys.
- HTTP method: `POST`.
- Timeout: 5 секунд.
- Ошибки `requests.RequestException` не пробрасываются, а печатаются через `print`.

Action mapping:

| Django событие | Engine action | URL |
|---|---|---|
| Create bot | `start` | `POST http://127.0.0.1:3001/engine/bot/start` |
| Update bot | `sync` | `POST http://127.0.0.1:3001/engine/bot/sync` |
| Delete bot | `stop` | `POST http://127.0.0.1:3001/engine/bot/stop` |
| Force close | `force-close` | `POST http://127.0.0.1:3001/engine/bot/force-close` |

Поведение при выключении `is_active`:

- Код все равно вызывает `sync`.
- Комментарий в коде говорит, что engine сам должен обработать `is_active=false`: не открывать новые сделки, но позволить текущим ордерам завершиться.

Важные замечания:

- Engine URL захардкожен и не конфигурируется через env.
- Ошибки синхронизации не видны API-клиенту: bot config может успешно сохраниться в Django, но engine не получить обновление.
- Используется `print`, а не structured logging.
- В payload уходят plaintext exchange secrets.

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

## 17. Важные риски и технический долг

### 17.1. Plaintext exchange secrets

`UserExchangeKeys` хранит secrets в обычных `CharField`. Это наиболее критичный риск.

Возможные улучшения:

- field-level encryption;
- KMS/secret manager;
- хранить только encrypted blob;
- запретить вывод secrets в admin/API/logs;
- audit trail доступа к ключам.

### 17.2. Service-token write endpoints

`EmulationTradeViewSet`, `TradeViewSet` и `TraderRuntimeConfigErrorViewSet` используют общий `X-Service-Token` для write methods.

Если API доступен извне и общий service token скомпрометирован, клиент потенциально может:

- создать сделку или runtime error;
- изменить сделку или runtime error;
- удалить сделку или runtime error;
- читать service-level данные.

Если это нужно для локального engine, лучше:

- вынести engine API под отдельный prefix;
- заменить общий service token на HMAC с подписью payload и timestamp;
- ограничить на reverse proxy по network allowlist;
- заменить публичные endpoints на narrow custom actions;
- сделать public часть read-only, если запись не нужна.

### 17.3. Bot-engine sync неатомарен

Django сначала сохраняет изменения, затем пытается уведомить engine. Ошибка engine не откатывает транзакцию и не возвращается клиенту.

Результат: Django state и engine state могут разойтись.

Варианты улучшения:

- хранить sync status/error на `BotConfig`;
- использовать outbox pattern;
- retry queue;
- Celery/RQ background task;
- вернуть warning клиенту;
- логировать ошибки нормальным logger-ом.

### 17.4. Engine URL захардкожен

`ENGINE_URL = "http://127.0.0.1:3001/engine/bot"` лежит в коде.

Лучше вынести в env:

```text
BOT_ENGINE_URL=http://127.0.0.1:3001/engine/bot
BOT_ENGINE_TIMEOUT_SECONDS=5
```

### 17.5. Нет тестов

В проекте не найдено `tests.py`, `tests/`, pytest config или Django TestCase. При изменениях сейчас опора только на `manage.py check` и ручные проверки.

Минимальный набор тестов:

- login по email;
- `/api/auth/me/`;
- logout blacklist behavior;
- owner scoping для `BotConfigViewSet`;
- create/update/delete bot вызывает нужный engine action;
- anonymous/auth queryset behavior для `EmulationTradeViewSet`;
- status filters для trades;
- serializer validation для choices/decimal fields.

### 17.6. `UserExchangeKeys` без admin

Модель есть, engine/trader payload ее использует, а пользовательское управление идет через `/api/auth/exchange-keys/`. Admin registration для ручного просмотра/поддержки не настроена.

### 17.7. `Trade` без owner/bot relation

Реальные сделки не привязаны к пользователю или боту. Это усложняет:

- multi-user isolation;
- аудит;
- фильтрацию в UI;
- удаление данных пользователя;
- расследование инцидентов.

Если real trading становится пользовательской функцией, лучше добавить связь хотя бы с `BotConfig` или `owner`.

### 17.8. README расходится с settings

README и `.env.example` намекают на default SQLite, но `development.py` требует `DATABASE_URL`. Нужно либо:

- обновить README;
- либо добавить default:

```python
env.db("DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}")
```

### 17.9. Production secret warning

`check --deploy` на текущем окружении выдает `security.W009`: текущий `SECRET_KEY` недостаточно сильный. Для production заменить.

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

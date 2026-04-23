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
- не ломай существующие пользовательские изменения и не откатывай чужие правки без прямой просьбы.

## 2. Язык

- Общение с пользователем, планы, объяснения и итоговые ответы: на русском языке.
- Комментарии в исходном коде: только на английском языке.
- Новые русскоязычные комментарии в коде запрещены.
- Пользовательская документация проекта в этом репозитории сейчас ведется на русском языке, если пользователь явно не просит другой язык.
- Названия API, классов, функций, переменных, commit messages и технические термины можно оставлять на английском, если это естественно для кода.

## 3. Обязательный workflow перед работой

Не читай всю документацию подряд. Сначала определи, в каком приложении или слое будет работа.

1. Определи область изменений по пути, команде пользователя или затронутым файлам.
2. Прочитай только релевантный `DOCS.md` для этой области.
3. Если задача затрагивает несколько приложений, прочитай `DOCS.md` каждого затронутого приложения.
4. Если меняется контракт между приложениями, дополнительно проверь обе стороны контракта в коде.
5. После изменений обнови соответствующий `DOCS.md`, если изменились архитектура, API, модели, env, команды, потоки данных, риски или поведение.

Актуальные документы по приложениям:

| Область | Документация | Когда читать |
|---|---|---|
| Django backend | `arbitration-art-django/DOCS.md` | Модели, API, auth, settings, Django admin, bot-engine sync |
| Bot engine | `arbitration-bot-engine/DOCS.md` | Fastify engine, runtime bot lifecycle, exchange execution, integration with Django |
| Standalone trader | `arbitration-trader/DOCS.md` | Standalone real-trading scanner/trader, exchange clients, deployment |
| Quasar frontend | `quasar/arbitration-art-q/DOCS.md` | Quasar/Vue UI, Pinia stores, frontend API, exchange WebSockets |

Если создается новое приложение, добавь в него `DOCS.md` и обнови эту таблицу.

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

Текущая структура:

```text
arbitration-art/
├── arbitration-art-django/       # Django REST backend
├── arbitration-bot-engine/       # Fastify runtime engine for bot configs
├── arbitration-trader/           # Standalone real arbitrage trader/scanner
├── quasar/arbitration-art-q/     # Quasar/Vue frontend
└── arbitration-scanner/          # Отдельный scanner-проект, документировать при работе с ним
```

Не путай `arbitration-bot-engine` и `arbitration-trader`:

- `arbitration-bot-engine` принимает lifecycle-команды от Django (`start`, `sync`, `stop`, `force-close`) и запускает runtime traders по bot config.
- `arbitration-trader` сам сканирует множество пар и торгует по глобальной `.env` конфигурации.

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

Приложения:

- `arbitration-bot-engine`
- `arbitration-trader`

Перед работой читать соответствующий `DOCS.md`.

Правила:

- Любые изменения торговой логики требуют особенно аккуратного анализа.
- Не меняй spread/PnL/drawdown формулы без явного объяснения и обновления документации.
- Не логируй API keys, secrets, private payloads.
- Учитывай partial fills, failed leg rollback, reduceOnly behavior, network timeouts, exchange API lag.
- После изменений в exchange clients обязательно проверь build.
- Комментарии в коде только на английском.

Проверки:

```bash
cd arbitration-bot-engine
pnpm build
```

```bash
cd arbitration-trader
pnpm build
```

Если build уже падает по известной причине, зафиксируй это в итоговом ответе и в `DOCS.md`, если причина новая.

## 9. API и межсервисные контракты

Если меняешь одну сторону контракта, проверь вторую:

- Django auth API -> Quasar `auth.ts` и `boot/axios.ts`.
- Django bots API -> Quasar `bots.store.ts` / `botConfig.ts`.
- Django bot-engine sync payload -> `arbitration-bot-engine/src/classes/Engine.ts`.
- Django real/emulation trades -> frontend dialogs, bot-engine, trader.
- Exchange enum/choices -> frontend exchange options and engine/trader mappings.

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

## 11. Работа с командами

В обычной Codex-среде можно запускать безопасные read/build/test команды для выполнения задачи. Если команда требует network, доступ к локальным сервисам или escalated permissions, запрашивай разрешение через инструмент.

Не запускай destructive commands без прямого запроса пользователя:

- `git reset --hard`
- `git checkout -- <file>`
- `rm -rf`
- destructive DB operations
- production trading commands

Если команда не может быть выполнена из-за окружения, сообщи:

- какая команда;
- почему не выполнена;
- что нужно сделать пользователю;
- как это влияет на уверенность в результате.

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

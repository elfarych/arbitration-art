# levels-api

HTTP API (Fastify + TypeScript) поверх рассчитанных уровней в Redis. Отдаёт
данные для скринера: список монет с дистанцией до ближайшего уровня в NATR,
фильтр по таймфрейму, детали по монете.

## Запуск

```bash
cp .env.example .env
npm install
npm run dev            # tsx watch
# или
npm run build && npm start
```

Нужны Redis и работающий `levels-processor` (тот же `LEVELS_PREFIX` =
`OUTPUT_PREFIX` процессора).

## Документация API

- **Полная спецификация для интеграции:** [API.md](./API.md) — модели,
  эндпоинты, query-параметры, примеры (можно работать из другого проекта).
- **Интерактивно:** Swagger UI — `http://localhost:3000/docs`;
  OpenAPI JSON — `http://localhost:3000/docs/json`.

## Эндпоинты (кратко)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/health` | Статус сервиса и Redis |
| GET | `/timeframes` | Доступные таймфреймы |
| GET | `/screener/:tf` | Экран скринера (фильтры/сортировка/пагинация) |
| GET | `/screener/:tf/:symbol` | Полные уровни по монете |

## Конфигурация (.env)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `HOST` | `0.0.0.0` | Хост |
| `PORT` | `3000` | Порт |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis |
| `LEVELS_PREFIX` | `levels` | Префикс данных (= `OUTPUT_PREFIX` процессора) |
| `CORS_ORIGIN` | `*` | Разрешённые origin |
| `LOG_LEVEL` | `info` | Уровень логов |

## Архитектура

```
index.ts → buildApp (Fastify + TypeBox type provider)
  ├─ @fastify/cors            CORS
  ├─ @fastify/swagger(+ui)    OpenAPI + Swagger UI на /docs
  ├─ plugins/redis           LevelsReader (ioredis)
  └─ routes/                  health · timeframes · screener
       └─ lib/screener-query  фильтры · сортировка · пагинация
```

Схемы (TypeBox) дают валидацию запросов, сериализацию ответов и OpenAPI из
одного источника. Чтение из Redis — только готовые ключи (`screener:<tf>`,
`detail:<tf>:<symbol>`, `timeframes`), без тяжёлых вычислений.

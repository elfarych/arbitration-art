# Arbitration Art — Django Backend

REST API backend для проекта Arbitration Art.

## Tech Stack

- **Python** 3.12+
- **Django** 6.0
- **Django REST Framework** 3.17
- **django-environ** — управление конфигурацией через `.env`
- **django-cors-headers** — CORS для взаимодействия с фронтендом

## Структура проекта

```
arbitration-art-django/
├── manage.py
├── .env                          # Переменные окружения (не в git)
├── .env.example                  # Шаблон переменных окружения
├── requirements/
│   ├── base.txt                  # Общие зависимости
│   ├── development.txt           # Dev-зависимости
│   └── production.txt            # Prod-зависимости
└── arbitration_art_django/
    ├── __init__.py
    ├── urls.py
    ├── wsgi.py
    ├── asgi.py
    └── settings/
        ├── __init__.py
        ├── base.py               # Общие настройки
        ├── development.py        # Настройки разработки
        └── production.py         # Настройки продакшена
```

## Быстрый старт

```bash
# 1. Активировать виртуальное окружение
source ../.venv/bin/activate

# 2. Установить зависимости
pip install -r requirements/development.txt

# 3. Скопировать .env (при первом запуске)
cp .env.example .env

# 4. Применить миграции
python manage.py migrate

# 5. Создать суперпользователя
python manage.py createsuperuser

# 6. Запустить сервер
python manage.py runserver
```

## Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `SECRET_KEY` | Секретный ключ Django | — (обязательно) |
| `DEBUG` | Режим отладки | `False` |
| `ALLOWED_HOSTS` | Разрешённые хосты | `[]` |
| `DATABASE_URL` | URL подключения к БД | `sqlite:///db.sqlite3` |
| `LANGUAGE_CODE` | Язык | `ru` |
| `TIME_ZONE` | Часовой пояс | `Asia/Almaty` |
| `CORS_ALLOWED_ORIGINS` | Разрешённые CORS-домены | `[]` |

## Settings

Настройки разделены на три модуля:

- **`base.py`** — общие настройки для всех окружений
- **`development.py`** — DEBUG, SQLite, browsable API, CORS allow all
- **`production.py`** — security hardening, HSTS, secure cookies

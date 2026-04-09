# Django Documentation (Arbitration Art)

## Overview
This is the REST API backend for the Arbitration Art project, built with Python 3.12+ and Django 6.0/DRF 3.17.

## Architecture & Structure
The backend uses a standard Django architecture with a segmented structure for apps and settings.

- **Location:** `arbitration-art-django/`
- **Django Project:** `arbitration_art_django/`
  - Features a split settings architecture (`base.py`, `development.py`, `production.py`) inside `arbitration_art_django/settings/`.
- **Apps:** Stored inside `apps/` directory within the virtual environment root. Currently available:
  - `users`: Contains a custom `User` model using `email` as the primary login field (inherited from `AbstractUser`) and handles user authentication and permissions.
  - `bots`: Contains `BotConfig` model representing an arbitrage bot configuration, containing fields like primary/secondary exchange (e.g., Binance, Mexc), entry/exit spreads, coin details, max trades, order types, and leverages. Also includes:
    - `EmulationTrade`: Stores emulated arbitrage trade cycles from the `arbitration-scanner` service.
    - `Trade`: Stores real arbitrage trade cycles from the `arbitration-trader` service, including actual exchange order IDs, commissions, fill prices, close reasons (profit/timeout/shutdown/error), and USDT profit tracking.

## Key Technical Decisions
- **Environment Variables:** Handled via `django-environ` (`.env` file).
- **CORS:** Managed via `django-cors-headers` for seamless frontend communication.
- **Dependencies:** Separated inside `requirements/` (`base.txt`, `development.txt`, `production.txt`).

## Managing & Running
- **Virtual Environment Setup:** `source ../.venv/bin/activate`
- **Dependencies Install:** `pip install -r requirements/development.txt`
- **Server Start:** `python manage.py runserver` (Defaults to local sqlite).

## AI Agent Notes
- Analyze `models.py` and `views.py` in the respective apps within `apps/` to understand data structures and endpoints.
- Update this document if new apps, major architectural changes, or specific integrations are introduced.

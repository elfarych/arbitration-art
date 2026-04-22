# API Documentation

Base URL: `http://localhost:8000/api/` (Default local development)
Authentication: JWT (JSON Web Tokens). Pass `Authorization: Bearer <token>`.

## 1. Authentication (`/api/auth/`)
Handles user authentication and JWT token lifecycle.

- **POST** `/auth/login/`
  - Body: `{"email": "user@example.com", "password": "secure"}`
  - Response: `{ "access": "<jwt_access_token>", "refresh": "<jwt_refresh_token>" }`

- **POST** `/auth/refresh/`
  - Body: `{"refresh": "<jwt_refresh_token>"}`
  - Response: `{ "access": "<new_jwt_access_token>" }`

- **POST** `/auth/logout/`
  - Terminates session / blacklists token.

- **GET** `/auth/me/`
  - Requires: Auth Token
  - Response: Details about the currently authenticated user.

## 2. Bots (`/api/bots/`)
CRUD operations for bot configurations. Requires Authentication. Only returns resources owned by the active user.

- **GET** `/bots/`
  - Response: List of bot configurations for the current user.
  - Example Response:
    ```json
    [
      {
        "id": 1,
        "primary_exchange": "binance_futures",
        "secondary_exchange": "mexc_futures",
        "entry_spread": "0.1500",
        "exit_spread": "0.0500",
        "coin": "BTC",
        "order_type": "auto",
        "is_active": true
      }
    ]
    ```

- **POST** `/bots/`
  - Use to create a new bot configuration. Assigns `owner` automatically to the request user.

- **GET** `/bots/{id}/`
  - Retrieves a specific bot's details.

- **PUT/PATCH** `/bots/{id}/`
  - Updates the specified bot's configurations.

- **DELETE** `/bots/{id}/`
  - Deletes the specified bot configuration.

## 3. Emulation Trades (`/api/bots/trades/`)
CRUD for emulated arbitrage trades (from `arbitration-scanner`). No authentication required.

- **GET** `/bots/trades/?status=open` — List trades, filterable by status.
- **POST** `/bots/trades/` — Create a new emulation trade.
- **PATCH** `/bots/trades/{id}/` — Update a trade (e.g., close it).

## 4. Real Trades (`/api/bots/real-trades/`)
CRUD for real arbitrage trades (from `arbitration-trader`). No authentication required for scanner access.

- **GET** `/bots/real-trades/?status=open`
  - Response: List of real trades, filterable by `status`.
  - Example Response:
    ```json
    [
      {
        "id": 1,
        "coin": "BTC/USDT:USDT",
        "primary_exchange": "binance_futures",
        "secondary_exchange": "bybit_futures",
        "order_type": "buy",
        "status": "open",
        "amount": "0.001",
        "leverage": 10,
        "primary_open_price": "67500.50000000",
        "secondary_open_price": "67480.20000000",
        "primary_open_order_id": "123456789",
        "secondary_open_order_id": "987654321",
        "open_spread": "0.0301",
        "open_commission": "0.027001",
        "opened_at": "2026-04-09T17:00:00Z"
      }
    ]
    ```

- **POST** `/bots/real-trades/` — Create a new real trade record.
- **PATCH** `/bots/real-trades/{id}/` — Update a trade (close with actual fill data).
  - Body includes: `status`, `close_reason`, `primary_close_price`, `secondary_close_price`, `primary_close_order_id`, `secondary_close_order_id`, `close_spread`, `close_commission`, `profit_usdt`, `profit_percentage`, `closed_at`.

## 5. Bot Engine API (`/engine/bot/`)
Internal endpoints exposed by the Fastify **Arbitration Bot Engine** (`arbitration-bot-engine/src/main.ts`). Typically called by the Django backend to manage bot lifecycles. All endpoints return `{ "success": true }` on success or an error object.

- **POST** `/engine/bot/start`
  - Body: `{"bot_id": "<string|number>", "config": {...}, "keys": {...}}`
  - Starts a new bot instance with the given configuration and exchange API keys.

- **POST** `/engine/bot/stop`
  - Body: `{"bot_id": "<string|number>"}`
  - Gracefully stops the running bot process.

- **POST** `/engine/bot/sync`
  - Body: `{"bot_id": "<string|number>", "config": {...}}`
  - Synchronizes a running bot instance with an updated configuration without full restart.

- **POST** `/engine/bot/force-close`
  - Body: `{"bot_id": "<string|number>"}`
  - Forcefully and immediately terminates the bot process.

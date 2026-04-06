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

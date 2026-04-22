# Architecture Decisions

## System Overview
The **Arbitration Art** architecture follows a strictly decoupled client-server model:
1. **Frontend (Client):** A Single Page Application (SPA) built using Quasar Framework.
2. **Backend (API):** A monolithic Django REST Framework application providing stateless JSON APIs.
3. **Arbitration Scanner** (`arbitration-scanner/`): Node.js/TypeScript service that monitors price spreads between Binance Futures and Bybit Futures and records emulated trades to Django.
4. **Arbitration Trader** (`arbitration-trader/`): Node.js/TypeScript service that performs **real arbitrage trading** on Binance Futures and Bybit Futures. Uses CCXT for exchange communication, WebSocket for orderbook monitoring, and records actual trade data (order IDs, fill prices, commissions) to Django.
5. **Arbitration Bot Engine** (`arbitration-bot-engine/`): Node.js/Fastify service that provides internal API endpoints `/engine/bot/*` to manage the lifecycle of trading bot instances (start, stop, sync, force-close).

## Layers & Components

### Frontend (Quasar)
- **UI Components (`src/components/`):** High decomposition, visual representation only.
- **Stores (`src/stores/`):** Business logic and state flow. **Strict Rule:** ALL API communications occur strictly here. No API requests directly inside UI components.
- **Pages/Layouts (`src/pages/`, `src/layouts/`):** Orchestrators mapping state to components. 

### Backend (Django)
- **Apps Architecture (`apps/`):** Logical division of features (e.g., `users`, `bots`).
- **Views/ViewSets:** Provide RESTful data endpoints. `ModelViewSet` is primarily used for standard CRUD operations (like `BotConfigViewSet`).
- **Serialization:** Transformation layers ensuring clean separation between DB models and HTTP responses.
- **Authentication:** Protected via SimpleJWT (JSON Web Tokens).

## Interaction Flow
1. Vue components dispatch actions to the Quasar stores.
2. Quasar stores perform async HTTP requests via services (Axios/Fetch) to Django.
3. Django routes the request through DRF serializers, performs database validations and operations, and returns JSON representations.
4. Stores parse the response, update their state, which in turn triggers reactive UI re-renders on the frontend.

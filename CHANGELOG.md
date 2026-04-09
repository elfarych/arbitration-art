# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **`arbitration-trader/`** — New Node.js/TypeScript real trading service for Binance Futures + Bybit Futures arbitrage.
  - Configurable trade amount (USDT), leverage, max concurrent trades, trade timeout.
  - Pre-calculates unified coin amounts at startup (identical for both exchanges).
  - Sets isolated margin and leverage on all USDT pairs at bootstrap.
  - Atomic order execution with partial-fill cleanup safety.
  - Real PnL calculation from actual fill prices minus commissions.
  - Graceful shutdown: closes all positions before exit.
  - Testnet support via `USE_TESTNET` flag.
- **Django `Trade` model** — Stores real trade execution data including exchange order IDs, commissions, close reasons (profit/timeout/shutdown/error), and USDT profit.
- **Django API** — `POST/PATCH/GET /api/bots/real-trades/` endpoints for trade management.
- **Django Admin** — `TradeAdmin` with organized fieldsets for open/close details.
- Created initial `.agent/workflows/rules.md` dictating strict code guidelines.
- Standardized documentation structure in root:
  - `README.md`, `architecture_doc.md`, `api_doc.md`, `CHANGELOG.md`.
- Added specific architectural breakdown files: `django_doc.md` and `quasar_doc.md`.
- Setup initial Custom `User` model using `email` authentication logic.
- Built initial `BotConfig` model and REST ViewSet to support Bot parameters and strategies.

### Changed
- Quasar development structure tightened (SASS restrictions, strict component decomposition, Store API-only policies).

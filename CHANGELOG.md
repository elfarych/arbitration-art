# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Created initial `.agent/workflows/rules.md` dictating strict code guidelines.
- Standardized documentation structure in root:
  - `README.md`, `architecture_doc.md`, `api_doc.md`, `CHANGELOG.md`.
- Added specific architectural breakdown files: `django_doc.md` and `quasar_doc.md`.
- Setup initial Custom `User` model using `email` authentication logic.
- Built initial `BotConfig` model and REST ViewSet to support Bot parameters and strategies.

### Changed
- Quasar development structure tightened (SASS restrictions, strict component decomposition, Store API-only policies).

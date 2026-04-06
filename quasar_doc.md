# Quasar Documentation (Arbitration Art)

## Overview
This is the frontend application for the Arbitration Art project, built using Vue 3 and Quasar Framework.

## Architecture & Structure
The frontend follows standard Quasar and Vue 3 conventions with strict rules for code decomposition and styling.

- **Location:** `quasar/arbitration-art-q/`
- **Source Directory:** `src/`
  - `components/`: Granular and highly reusable UI components. No large files containing all logic and layout together.
  - `layouts/`, `pages/`: Routing-based entry points.
  - `composables/`: Reusable Vue 3 Composition API logic.
  - `stores/`: State management (Pinia) using a **Feature-Based Structure**. For each feature, create a dedicated folder here. This folder must encapsulate everything related to the feature: the store file, data models/types, and API services.
  - `services/`: Global or shared generic API interaction logic (feature-specific logic now belongs in `stores/<feature>/`).

## Strict Rules
- **UI Framework:** Maximize the use of built-in Quasar components.
- **Styling constraints (`SASS` only!):**
  - **Allowed:** `<style lang="sass" scoped>`.
  - **Forbidden:** Standard CSS and SCSS.
  - **Variables:** Use _only_ variables originating from `src/css/quasar.variables.sass`. Do not hardcode colors.
  - **Typography:** Limited to maximum 4 font sizes as defined in the variables file.
  - **Style Guide:** Maintain the app's style scheme instead of writing custom specific styles for overlapping elements.
  - **Buttons:** All `q-btn` must include `no-caps` property.
- **Components:** Logic must be heavily decomposed. Keep components small, readable, and focused. Overly large component files are not accepted.
- **API & Requests:** STRICT RULE: NEVER write API requests and work with APIs outside of the `stores`. All API logic must be encapsulated within the application's state management stores.

## Managing & Running
- **Dependencies:** `npm install` or `yarn` (A `pnpm-lock.yaml` is present, so `pnpm install` is heavily recommended if using PNPM).
- **Development Server:** `quasar dev`
- **Production Build:** `quasar build`

## AI Agent Notes
- Ensure strict adherence to the SCSS -> SASS rule and NO_CAPS button constraints.
- Before scaffolding large pages, verify if some of its parts can be decoupled into `components/`.
- English code comments are mandatory. Update this doc if new system directories or core patterns emerge.

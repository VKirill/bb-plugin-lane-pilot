---
title: i18n workspace overview
type: overview
created: 2026-10-24
updated: 2026-10-30
status: active
confidence: high
tags: [i18n, localization, workspace]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-agent-labels.ts
  - packages/i18n/src/i18n-workflows.ts
  - packages/i18n/src/i18n-workflow-editor.ts
  - packages/i18n/src/i18n-workflow-ops.ts
  - packages/i18n/src/i18n-workflow-models.ts
  - packages/i18n/src/i18n-workflow-canvas.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/src/i18n-schedule.ts
  - packages/i18n/src/i18n-improvement.ts
  - packages/i18n/src/i18n-role-models.ts
  - packages/i18n/src/i18n-owned.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/index.ts
  - packages/i18n/package.json
  - app.tsx
  - packages/settings-catalog/src/channels.ts
  - packages/i18n/src/i18n-graph.ts
  - src/rooms/ui-shell/ui/page.tsx
  - src/rooms/runs/server/rpc/runs.ts
  - package.json
---
# i18n workspace overview

TL;DR: `@lane-pilot/i18n` provides typed English and Russian UI dictionaries and shared locale selection and message-label helpers; the plugin app imports it through the package root (`packages/i18n/src/index.ts:1`, `app.tsx:3`).

## What it is

The workspace combines a base Lane Pilot dictionary (settings chrome, run card states, team roster and role-model pool labels, model-override reset texts) with domain catalogs for settings fields, workflow screens, editor, operations, model view, canvas, schedules, task board with its offline messages, ownership, agent profile editing, anamnesis, tabs, graph views, JEV, improvement screens, cockpit, role models, and the agent picker names (`packages/i18n/src/i18n.ts:21`, `packages/i18n/src/i18n.ts:85-101`, `packages/i18n/src/i18n.ts:190-206`, `packages/i18n/src/i18n.ts:1-19`, `packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-workflow-editor.ts:1-2`, `packages/i18n/src/i18n-workflow-ops.ts:1-2`, `packages/i18n/src/i18n-workflow-models.ts:1-2`, `packages/i18n/src/i18n-workflow-canvas.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`, `packages/i18n/src/i18n-agent-labels.ts:2-16`). `en` and `ru` merge catalogs in the same order, with agent-label strings spread last, after role-model and cockpit strings; the Russian dictionary is typed to the English key set (`packages/i18n/src/i18n.ts:2217-2223`). The schedule catalog contains automation board, calendar, task creation, history, and model/cost labels (`packages/i18n/src/i18n-schedule.ts:3-18`, `packages/i18n/src/i18n-schedule.ts:69-80`, `packages/i18n/src/i18n-schedule.ts:89-123`, `packages/i18n/src/i18n-schedule.ts:132-163`). The profile catalog contains conflict and draft retention messages along with profile form labels (`packages/i18n/src/i18n-owned.ts:3-21`). The graph catalog contains strings for stage and model views (`packages/i18n/src/i18n-graph.ts:1-2`, `packages/i18n/src/i18n-graph.ts:59-60`). The cockpit pair defines strings for screen names, controls, and screen content (`packages/i18n/src/i18n-cockpit.ts:1-2`, `packages/i18n/src/i18n-cockpit.ts:18-30`, `packages/i18n/src/i18n-cockpit.ts:144-156`).

The package has no application bootstrap. Importing its entry point loads the translation module, while consumers call the exported functions when rendering text (`packages/i18n/src/index.ts:1`, `packages/i18n/src/i18n.ts:2288-2290`). The root plugin app uses `detectLocale` and `t` directly (`app.tsx:3`).

## Stack

- TypeScript module package with a single `.` export to `src/index.ts` (`packages/i18n/package.json:1-13`).
- `@lane-pilot/settings-catalog` supplies canonical unapplied-reason constants used by the translated reason helper (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n.ts:2312-2327`).

## Configuration

The package manifest exposes only the root import path; it declares no runtime options or environment variables (`packages/i18n/package.json:10-13`). Locale selection reads a shared explicit override first, then a Russianizer hint, browser language, document language, and English fallback (`packages/i18n/src/i18n.ts:2245-2264`). The detailed selection and translation rules belong to [Locale resolution and translation](features/locale-and-translation.md).

## Public entry points

The package root re-exports all declarations from `i18n.ts` (`packages/i18n/src/index.ts:1`). Its public API includes `en`, `ru`, `I18nKey`, `Locale`, `LocalePreference`, `setLocaleOverride`, `localeFromSources`, `detectLocale`, `detectLocaleHint`, `subscribeToLocaleHintChanges`, `t`, `validationMessage`, `stateLabel`, `unappliedReason`, and `currentStrings` (`packages/i18n/src/i18n.ts:2217-2223`, `packages/i18n/src/i18n.ts:2228-2290`, `packages/i18n/src/i18n.ts:2292-2345`).

## Workspace consumers

The plugin application imports the package from its root `app.tsx`, and room UI and server modules import its API across the root workspace (`app.tsx:3`, `src/rooms/ui-shell/ui/page.tsx:2`, `src/rooms/runs/server/rpc/runs.ts:1`). The monorepo declares `packages/*` as workspaces (`package.json:96-98`).

## Where to look next

- [Locale resolution and translation](features/locale-and-translation.md) — runtime behavior, exported API, and catalog organization.
- [Gotchas](gotchas.md) — key collisions, override behavior, and unknown-label fallbacks.
- [Monorepo architecture](../../../docs/architecture.md) — cross-workspace system context.

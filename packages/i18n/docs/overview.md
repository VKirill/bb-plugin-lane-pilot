---
title: i18n workspace overview
type: overview
created: 2026-10-24
updated: 2026-11-11
status: active
confidence: high
tags: [i18n, localization, workspace]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-anamnesis.ts
  - packages/i18n/src/i18n-errands.ts
  - packages/i18n/src/i18n-agent-labels.ts
  - packages/i18n/src/i18n-workflows.ts
  - packages/i18n/src/i18n-workflow-editor.ts
  - packages/i18n/src/i18n-workflow-ops.ts
  - packages/i18n/src/i18n-workflow-models.ts
  - packages/i18n/src/i18n-workflow-library.ts
  - packages/i18n/src/i18n-workflow-export.ts
  - packages/i18n/src/i18n-workflow-map.ts
  - packages/i18n/src/i18n-workflow-canvas.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/src/i18n-schedule.ts
  - packages/i18n/src/i18n-improvement.ts
  - packages/i18n/src/i18n-role-models.ts
  - packages/i18n/src/i18n-fields.ts
  - packages/i18n/src/i18n-owned.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/index.ts
  - packages/i18n/package.json
  - app.tsx
  - packages/settings-catalog/src/channels.ts
  - packages/i18n/src/i18n-graph.ts
  - packages/i18n/src/i18n-tabs.ts
  - src/rooms/runs/ui/task-board.tsx
  - src/rooms/acceptance/ui/acceptance-card.tsx
  - src/rooms/work-graph/ui/work-breakdown.tsx
  - src/rooms/cockpit/ui/screens-day.tsx
  - src/rooms/pages/page.tsx
  - src/rooms/runs/server/rpc/runs.ts
  - package.json
---
# i18n workspace overview

TL;DR: `@lane-pilot/i18n` provides English and Russian UI dictionaries and shared locale selection and message-label helpers. The package entry point re-exports `i18n.ts` (`packages/i18n/src/index.ts:1`). The plugin app imports the locale detection and translation helpers from the package root (`app.tsx:3`).

## What it is

The workspace combines a base Lane Pilot dictionary (settings chrome, run card states, team roster and ordered role-fallback labels, model-override reset texts) with domain catalogs for settings fields, workflow screens and library filters, graph export and map views, editor, operations, model view, canvas, schedules, task board with phase and batch labels, held, gate, and wave labels, acceptance-card controls, and offline messages, ownership, agent profile editing, anamnesis, tabs, graph views, JEV, improvement screens, errands, cockpit, role models, and agent picker names (`packages/i18n/src/i18n-agent-labels.ts:1-2`, `packages/i18n/src/i18n.ts:25`, `packages/i18n/src/i18n.ts:86-102`, `packages/i18n/src/i18n.ts:190-212`, `packages/i18n/src/i18n.ts:1-23`, `packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-workflow-library.ts:1-20`, `packages/i18n/src/i18n-workflow-export.ts:1-26`, `packages/i18n/src/i18n-workflow-map.ts:1-41`, `packages/i18n/src/i18n-workflow-editor.ts:1-2`, `packages/i18n/src/i18n-workflow-ops.ts:1-2`, `packages/i18n/src/i18n-workflow-models.ts:1-2`, `packages/i18n/src/i18n-workflow-canvas.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-board.ts:9-17`, `packages/i18n/src/i18n-board.ts:203-213`, `packages/i18n/src/i18n-board.ts:109`, `packages/i18n/src/i18n-board.ts:236`, `src/rooms/runs/ui/task-board.tsx:108-115`, `src/rooms/runs/ui/task-board.tsx:200`, `src/rooms/acceptance/ui/acceptance-card.tsx:68`, `src/rooms/acceptance/ui/acceptance-card.tsx:230`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`). `en` and `ru` merge catalogs in the same order, with export and map strings spread after agent-label strings; the Russian dictionary is typed to the English key set (`packages/i18n/src/i18n.ts:2495-2496`). The schedule catalog contains automation board, calendar, task creation, history, and model/cost labels (`packages/i18n/src/i18n-schedule.ts:3-18`, `packages/i18n/src/i18n-schedule.ts:69-80`, `packages/i18n/src/i18n-schedule.ts:89-123`, `packages/i18n/src/i18n-schedule.ts:132-163`). The profile catalog contains conflict and draft retention messages along with profile form labels (`packages/i18n/src/i18n-owned.ts:3-21`). The graph catalog contains strings for stage and model views, plus turn and monthly spending ceiling labels (`packages/i18n/src/i18n-graph.ts:1-7`, `packages/i18n/src/i18n-graph.ts:61-67`, `src/rooms/work-graph/ui/work-breakdown.tsx:98-99`). The cockpit pair defines strings for screen names, controls, screen content, the Rules screen hazard and switch labels, and running worker counts with task names (`packages/i18n/src/i18n-cockpit.ts:1-2`, `packages/i18n/src/i18n-cockpit.ts:18-39`, `packages/i18n/src/i18n-cockpit.ts:100`, `packages/i18n/src/i18n-cockpit.ts:128-156`, `packages/i18n/src/i18n-cockpit.ts:237-248`, `packages/i18n/src/i18n-cockpit.ts:286`, `src/rooms/cockpit/ui/screens-day.tsx:187`). The errands catalog holds the Errands page strings: the six errand kinds with what each covers, per-kind model labels, list columns, run outcomes including checked and unchecked outcomes, where an errand was asked from, and how its kind was chosen (`packages/i18n/src/i18n-errands.ts:9-16`, `packages/i18n/src/i18n-errands.ts:22-24`, `packages/i18n/src/i18n-errands.ts:50`). The anamnesis catalog provides labels, help text describing the database on the hub, and view names for the anamnesis tab (`packages/i18n/src/i18n-anamnesis.ts:2-5`, `packages/i18n/src/i18n-anamnesis.ts:26-30`, `packages/i18n/src/i18n-anamnesis.ts:135-138`). The fields catalog labels errand episode collection, process-key modes, and the writer session turn ceiling; the last description states a five-turn default (`packages/i18n/src/i18n-fields.ts:1058-1069`, `packages/i18n/src/i18n-fields.ts:2128-2139`). The base dictionary defines the episode process-key enum option strings (`packages/i18n/src/i18n.ts:988-991`, `packages/i18n/src/i18n.ts:2223-2226`).

The package has no application bootstrap. Importing its entry point loads the translation module (`packages/i18n/src/index.ts:1`). Consumers call the exported translation function when rendering text (`packages/i18n/src/i18n.ts:2566-2568`).

## Stack

- ES module package with a single `.` export to `src/index.ts` (`packages/i18n/package.json:4`, `packages/i18n/package.json:10-13`).
- `@lane-pilot/settings-catalog` supplies canonical unapplied-reason constants (`UNAPPLIED_REASON`) used by the translated reason helper (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n.ts:2590-2614`).

## Configuration

The package manifest exposes `.` as its only import path to `src/index.ts` (`packages/i18n/package.json:10-13`).

`detectLocale` checks the global override shared across bundles, then the module-local override, then automatic hints; automatic detection resolves the Russianizer hint, navigator language, document language, and English fallback in that order (`packages/i18n/src/i18n.ts:2506-2542`). See [Locale resolution and translation](features/locale-and-translation.md) for the full rules.

## Public entry points

The package root re-exports declarations from `i18n.ts` (`packages/i18n/src/index.ts:1`).

The public API includes `en`, `ru`, `I18nKey`, `Locale`, and `LocalePreference` (`packages/i18n/src/i18n.ts:2495-2501`). Exported translation and locale helpers (`setLocaleOverride`, `localeFromSources`, `detectLocale`, `detectLocaleHint`, `subscribeToLocaleHintChanges`, `t`, `validationMessage`, `stateLabel`, `unappliedReason`, and `currentStrings`) are documented in [Locale resolution and translation](features/locale-and-translation.md#public-api).

## Workspace consumers

The plugin application imports the package from its root `app.tsx`, and room UI and server modules import its API across the root workspace (`app.tsx:3`, `src/rooms/pages/page.tsx:2`, `src/rooms/runs/server/rpc/runs.ts:3`). The monorepo declares `packages/*` as workspaces (`package.json:97-99`).

## Where to look next

- [Locale resolution and translation](features/locale-and-translation.md) — runtime behavior, exported API, and catalog organization.
- [Gotchas](gotchas.md) — key collisions, override behavior, and unknown-label fallbacks.
- [Monorepo architecture](../../../docs/architecture.md) — cross-workspace system context.

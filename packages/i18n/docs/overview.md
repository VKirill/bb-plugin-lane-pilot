---
title: i18n workspace overview
type: overview
created: 2026-10-24
updated: 2026-10-24
status: active
confidence: medium
tags: [i18n, localization, workspace]
sources:
  - packages/i18n/src/i18n.ts
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

The workspace combines a base Lane Pilot dictionary with domain catalogs for settings fields, workflow editing and operations, schedules, boards, ownership, anamnesis, tabs, graph views, JEV, and improvement screens. `en` and `ru` are assembled from these catalogs, and the Russian dictionary is typed to the English key set (`packages/i18n/src/i18n.ts:2-16`, `packages/i18n/src/i18n.ts:2160-2165`). The graph catalog is one such pair and contains strings for stage and model views (`packages/i18n/src/i18n-graph.ts:1-2`, `packages/i18n/src/i18n-graph.ts:59-60`).

The package has no application bootstrap. Importing its entry point loads the translation module, while consumers call the exported functions when rendering text (`packages/i18n/src/index.ts:1`, `packages/i18n/src/i18n.ts:2230-2232`). The root plugin app uses `detectLocale` and `t` directly (`app.tsx:3`).

## Stack

- TypeScript module package with a single `.` export to `src/index.ts` (`packages/i18n/package.json:1-13`).
- `@lane-pilot/settings-catalog` supplies canonical unapplied-reason constants used by the translated reason helper (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n.ts:2254-2269`).

## Configuration

The package manifest exposes only the root import path; it declares no runtime options or environment variables (`packages/i18n/package.json:10-13`). Locale selection reads a shared explicit override first, then a Russianizer hint, browser language, document language, and English fallback (`packages/i18n/src/i18n.ts:2187-2205`). The detailed selection and translation rules belong to [Locale resolution and translation](features/locale-and-translation.md).

## Public entry points

The package root re-exports all declarations from `i18n.ts` (`packages/i18n/src/index.ts:1`). Its public API includes `en`, `ru`, `I18nKey`, `Locale`, `LocalePreference`, `setLocaleOverride`, `localeFromSources`, `detectLocale`, `detectLocaleHint`, `subscribeToLocaleHintChanges`, `t`, `validationMessage`, `stateLabel`, `unappliedReason`, and `currentStrings` (`packages/i18n/src/i18n.ts:2160-2165`, `packages/i18n/src/i18n.ts:2170-2233`, `packages/i18n/src/i18n.ts:2234-2287`).

## Workspace consumers

The plugin application imports the package from its root `app.tsx`, and room UI and server modules import its API across the root workspace (`app.tsx:3`, `src/rooms/ui-shell/ui/page.tsx:2`, `src/rooms/runs/server/rpc/runs.ts:1`). The monorepo declares `packages/*` as workspaces (`package.json:96-98`).

## Where to look next

- [Locale resolution and translation](features/locale-and-translation.md) — runtime behavior, exported API, and catalog organization.
- [Gotchas](gotchas.md) — key collisions, override behavior, and unknown-label fallbacks.
- [Monorepo architecture](../../../docs/architecture.md) — cross-workspace system context.

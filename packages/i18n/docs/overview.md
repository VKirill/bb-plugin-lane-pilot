---
title: i18n workspace overview
type: overview
created: 2026-10-24
updated: 2026-11-16
status: active
confidence: high
tags: [i18n, localization, workspace]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/role-names.ts
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
  - src/rooms/runs/ui/workflow-run-steps.tsx
  - src/rooms/acceptance/ui/acceptance-card.tsx
  - src/rooms/work-graph/ui/work-breakdown.tsx
  - src/rooms/cockpit/ui/screens-day.tsx
  - src/rooms/cockpit/ui/screens-ops.tsx
  - src/rooms/pages/page.tsx
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/ui/thread-live.tsx
  - package.json
---
# i18n workspace overview

TL;DR: `@lane-pilot/i18n` provides English and Russian UI dictionaries, canonical role display names, and shared locale selection and message-label helpers. The package entry point re-exports `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`). The plugin app imports the locale detection and translation helpers from the package root (`app.tsx:3`).

## What it is

The workspace combines a base Lane Pilot dictionary (settings chrome, run card states, team roster and ordered role-fallback labels, model-override reset texts) with domain catalogs for settings fields, workflow screens and library filters, graph export and map views, editor, operations, model view, canvas, schedules, task board with phase and batch labels, held, gate, and wave labels, workflow step results and engine step states, acceptance-card controls, and offline messages, ownership, agent profile editing, anamnesis, tabs, graph views, improvement screens, errands, cockpit, role models, and agent picker names (`packages/i18n/src/i18n-agent-labels.ts:2-3`, `packages/i18n/src/i18n.ts:25`, `packages/i18n/src/i18n.ts:89-105`, `packages/i18n/src/i18n.ts:197-217`, `packages/i18n/src/i18n.ts:1-23`, `packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-workflow-library.ts:1-20`, `packages/i18n/src/i18n-workflow-export.ts:1-26`, `packages/i18n/src/i18n-workflow-map.ts:1-41`, `packages/i18n/src/i18n-workflow-editor.ts:1-2`, `packages/i18n/src/i18n-workflow-ops.ts:1-2`, `packages/i18n/src/i18n-workflow-models.ts:1-2`, `packages/i18n/src/i18n-workflow-canvas.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-board.ts:9-17`, `packages/i18n/src/i18n-board.ts:44`, `packages/i18n/src/i18n-board.ts:182-184`, `packages/i18n/src/i18n-board.ts:208-216`, `packages/i18n/src/i18n-board.ts:110`, `packages/i18n/src/i18n-board.ts:240`, `packages/i18n/src/i18n-board.ts:254`, `packages/i18n/src/i18n-board.ts:381-383`, `src/rooms/runs/ui/task-board.tsx:114-120`, `src/rooms/runs/ui/task-board.tsx:206`, `src/rooms/runs/ui/task-board.tsx:453`, `src/rooms/runs/ui/workflow-run-steps.tsx:15`, `src/rooms/runs/ui/workflow-run-steps.tsx:32`, `src/rooms/acceptance/ui/acceptance-card.tsx:68`, `src/rooms/acceptance/ui/acceptance-card.tsx:230`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`). A canonical role-name registry supplies bilingual names, kinds, and groups for every agent, judge, and Codex profile, and feeds role display keys across `i18n.ts`, `i18n-agent-labels.ts`, and `i18n-role-models.ts` (`packages/i18n/src/role-names.ts:1-160`, `packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`); see [Canonical role names](features/role-names.md). The library, graph map, and export catalogs include a Marketing category, and the agent and role-model catalogs include Growth marketer labels (`packages/i18n/src/i18n-workflow-library.ts:2-6`, `packages/i18n/src/i18n-workflow-export.ts:18-20`, `packages/i18n/src/i18n-workflow-map.ts:6-10`, `packages/i18n/src/i18n-agent-labels.ts:16`, `packages/i18n/src/i18n-role-models.ts:56`, `packages/i18n/src/i18n-role-models.ts:73`). `en` and `ru` merge catalogs in the same order, with export and map strings spread after agent-label strings; the Russian dictionary is typed to the English key set (`packages/i18n/src/i18n.ts:2483-2484`). The schedule catalog contains automation board, calendar, task creation, history, and model/cost labels (`packages/i18n/src/i18n-schedule.ts:3-18`, `packages/i18n/src/i18n-schedule.ts:69-80`, `packages/i18n/src/i18n-schedule.ts:89-123`, `packages/i18n/src/i18n-schedule.ts:132-163`). The profile catalog contains conflict and draft retention messages along with profile form labels (`packages/i18n/src/i18n-owned.ts:3-21`). The graph catalog contains strings for stage and model views, turn and monthly spending ceiling labels, and the thread live panel's open-session label (`packages/i18n/src/i18n-graph.ts:1-7`, `packages/i18n/src/i18n-graph.ts:58`, `packages/i18n/src/i18n-graph.ts:63-67`, `packages/i18n/src/i18n-graph.ts:119`, `src/rooms/work-graph/ui/work-breakdown.tsx:98-99`, `src/rooms/runs/ui/thread-live.tsx:85-91`). The cockpit pair defines strings for screen names, controls, screen content, the Rules screen hazard and switch labels, running worker counts with task names, and a weak-match note for memory search (`packages/i18n/src/i18n-cockpit.ts:1-2`, `packages/i18n/src/i18n-cockpit.ts:18-39`, `packages/i18n/src/i18n-cockpit.ts:100`, `packages/i18n/src/i18n-cockpit.ts:309`, `packages/i18n/src/i18n-cockpit.ts:128-156`, `packages/i18n/src/i18n-cockpit.ts:237-248`, `packages/i18n/src/i18n-cockpit.ts:286`, `src/rooms/cockpit/ui/screens-day.tsx:187`, `src/rooms/cockpit/ui/screens-ops.tsx:75`). The errands catalog holds the Errands page strings: the six errand kinds with what each covers, per-kind model labels, list columns, run outcomes including checked and unchecked outcomes, where an errand was asked from, and whether its kind came from the PM, brief, or schedule (`packages/i18n/src/i18n-errands.ts:9-16`, `packages/i18n/src/i18n-errands.ts:22-24`, `packages/i18n/src/i18n-errands.ts:50-52`). The anamnesis catalog provides labels, help text describing the database on the hub, and view names for the anamnesis tab (`packages/i18n/src/i18n-anamnesis.ts:2-5`, `packages/i18n/src/i18n-anamnesis.ts:26-30`, `packages/i18n/src/i18n-anamnesis.ts:135-138`). The fields catalog labels merged worktree cleanup age (seven-day default), errand episode collection and its `shadow`/`active` process-key modes, sets out the writer session turn ceiling with a five-turn default, and adds the memory search judge settings and `sensitive` owner-words mode copy (`packages/i18n/src/i18n-fields.ts:1018-1019`, `packages/i18n/src/i18n-fields.ts:2078-2079`, `packages/i18n/src/i18n-fields.ts:1034-1035`, `packages/i18n/src/i18n-fields.ts:2094-2095`, `packages/i18n/src/i18n-fields.ts:1038-1041`, `packages/i18n/src/i18n-fields.ts:2098-2101`, `packages/i18n/src/i18n-fields.ts:1048-1059`, `packages/i18n/src/i18n-fields.ts:2108-2119`). The base dictionary defines the episode process-key enum option strings along with `sensitive` owner-words, plan-revision routing and owned-path threshold labels and enum options, `memory.scope`, and `codex.lean_roles` UI labels (`packages/i18n/src/i18n.ts:739`, `packages/i18n/src/i18n.ts:771-774`, `packages/i18n/src/i18n.ts:808-813`, `packages/i18n/src/i18n.ts:966-968`, `packages/i18n/src/i18n.ts:982-983`, `packages/i18n/src/i18n.ts:1002-1003`, `packages/i18n/src/i18n.ts:1981`, `packages/i18n/src/i18n.ts:2000-2003`, `packages/i18n/src/i18n.ts:2037-2042`, `packages/i18n/src/i18n.ts:2195-2197`, `packages/i18n/src/i18n.ts:2211-2212`, `packages/i18n/src/i18n.ts:2231-2232`).

The package has no application bootstrap. Importing its entry point loads the translation and role-name modules (`packages/i18n/src/index.ts:1-2`). Consumers call `t` when rendering text; it selects `ru[key]` or `en[key]` by the detected locale (`packages/i18n/src/i18n.ts:2554-2556`).

## Stack

- ES module package with a single `.` export to `src/index.ts` (`packages/i18n/package.json:4`, `packages/i18n/package.json:10-13`).
- `@lane-pilot/settings-catalog` supplies canonical unapplied-reason constants (`UNAPPLIED_REASON`) used by the translated reason helper (`packages/i18n/src/i18n.ts:2`, `packages/i18n/src/i18n.ts:2578-2602`).

## Configuration

The package manifest exposes `.` as its only import path to `src/index.ts` (`packages/i18n/package.json:10-13`).

`detectLocale` checks the global override shared across bundles, then the module-local override, then automatic hints; automatic detection resolves the Russianizer hint, navigator language, document language, and English fallback in that order (`packages/i18n/src/i18n.ts:2494-2530`). See [Locale resolution and translation](features/locale-and-translation.md) for the full rules.

## Public entry points

The package root re-exports declarations from `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`).

The public API includes `en`, `ru`, `I18nKey`, `Locale`, and `LocalePreference` (`packages/i18n/src/i18n.ts:2483-2489`). Exported translation and locale helpers (`setLocaleOverride`, `localeFromSources`, `detectLocale`, `detectLocaleHint`, `subscribeToLocaleHintChanges`, `t`, `validationMessage`, `stateLabel`, `unappliedReason`, `currentStrings`, and `roleName`) are documented in [Locale resolution and translation](features/locale-and-translation.md#public-api). The canonical role-name registry and helpers (`ROLE_NAMES`, `ROLE_NAME_IDS`, `ROLE_ID_ALIASES`, `canonicalRoleId`, `roleDisplayName`, `roleLabel`, `roleNameEn`, `roleNameRu`, and role types) are documented in [Canonical role names](features/role-names.md#public-api).

## Workspace consumers

The plugin application imports the package from its root `app.tsx`, and room UI and server modules import its API across the root workspace (`app.tsx:3`, `src/rooms/pages/page.tsx:2`, `src/rooms/runs/server/rpc/runs.ts:5`). The monorepo declares `packages/*` as workspaces (`package.json:103-105`).

## Where to look next

- [Locale resolution and translation](features/locale-and-translation.md) — runtime behavior, exported API, and catalog organization.
- [Canonical role names](features/role-names.md) — unified role-name map, aliases, kinds, and display helpers.
- [Gotchas](gotchas.md) — key collisions, override behavior, and unknown-label fallbacks.
- [Monorepo architecture](../../../docs/architecture.md) — cross-workspace system context.

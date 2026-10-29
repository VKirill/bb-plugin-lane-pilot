---
title: Locale resolution and translation
type: component
created: 2026-10-24
updated: 2026-10-29
status: active
confidence: high
tags: [i18n, locale, translations]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-board.ts
  - packages/i18n/src/i18n-cockpit.ts
  - packages/i18n/src/i18n-fields.ts
  - packages/i18n/src/i18n-improvement.ts
  - packages/i18n/src/i18n-role-models.ts
  - packages/i18n/src/i18n-schedule.ts
  - packages/i18n/src/i18n-tabs.ts
  - packages/i18n/src/i18n-workflow-canvas.ts
  - packages/i18n/src/i18n-workflow-editor.ts
  - packages/i18n/src/i18n-workflow-models.ts
  - packages/i18n/src/i18n-workflow-ops.ts
  - packages/i18n/src/i18n-workflows.ts
  - packages/i18n/src/i18n-owned.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n-graph.ts
  - packages/i18n/tests/i18n.test.ts
  - src/rooms/runs/ui/run-card.tsx
  - src/rooms/runs/ui/task-board.tsx
  - src/rooms/ui-shell/ui/tab-team.tsx
  - src/rooms/settings/ui/role-models.tsx
  - src/rooms/settings/ui/model-overrides.tsx
  - packages/settings-catalog/src/channels.ts
  - packages/i18n/package.json
  - app.tsx
  - src/rooms/runs/server/rpc/runs.ts
---
# Locale resolution and translation

TL;DR: This component merges English and Russian UI catalogs, selects a locale from a shared override or browser hints, and exposes typed translation and label helpers (`packages/i18n/src/i18n.ts:2216-2221`, `packages/i18n/src/i18n.ts:2243-2289`).

## Purpose

The component provides shared text for the plugin UI. `I18nKey` is derived from the English dictionary, `Locale` is `"en" | "ru"`, and the Russian dictionary is constrained to the English key set (`packages/i18n/src/i18n.ts:2216-2221`). Catalog files partition strings by feature: workflow screens, editor, operations, model view, canvas, task board, schedules, tabs, self-improvement, role models, fields, and cockpit have dedicated catalogs (`packages/i18n/src/i18n.ts:2-17`, `packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-workflow-editor.ts:1-2`, `packages/i18n/src/i18n-workflow-ops.ts:1-2`, `packages/i18n/src/i18n-workflow-models.ts:1-2`, `packages/i18n/src/i18n-workflow-canvas.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-schedule.ts:1-2`, `packages/i18n/src/i18n-tabs.ts:1-2`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`, `packages/i18n/src/i18n-fields.ts:1`, `packages/i18n/src/i18n-cockpit.ts:1-2`).

## How it works

1. The package entry point re-exports `i18n.ts`; that module imports each catalog pair and `UNAPPLIED_REASON` from `settings-catalog` (`packages/i18n/src/index.ts:1`, `packages/i18n/src/i18n.ts:2-17`).
2. `en` and `ru` merge their corresponding catalogs in the same order. `roleModels` is spread last, after `cockpit`; `ru` uses the English dictionary's keys as its type (`packages/i18n/src/i18n.ts:2216-2221`).
3. `detectLocale` checks the global override shared across bundles, then the module override, then calls `detectLocaleHint` (`packages/i18n/src/i18n.ts:2243-2249`).
4. `detectLocaleHint` recognizes the Russianizer only when its footer marker exists; local storage value `"off"` disables that hint, while other values leave it enabled. Storage access exceptions are caught (`packages/i18n/src/i18n.ts:2250-2263`).
5. `localeFromSources` chooses Russianizer hint first, then a non-empty navigator language, then a non-default document language, and otherwise English. A recognized language prefix `ru` maps to Russian; other supplied languages map to English (`packages/i18n/src/i18n.ts:2233-2242`).
6. `t` returns the key's value from the selected dictionary. `subscribeToLocaleHintChanges` watches document mutations and matching storage events, notifies only when its detected hint changes, and returns a disposer that disconnects both listeners (`packages/i18n/src/i18n.ts:2264-2289`).
7. Specialized helpers map validation codes, state names, and unapplied reasons to translated strings; unknown state names and unknown reason formats are returned unchanged (`packages/i18n/src/i18n.ts:2290-2335`).

### Locale modes

| Mode | Input and precedence | Output | Failure or fallback |
|---|---|---|---|
| Explicit override | `setLocaleOverride("en" | "ru")`; global override is checked before module-local state | Forced dictionary locale | Passing `null` clears both override values, after which detection uses hints (`packages/i18n/src/i18n.ts:2223-2232`, `packages/i18n/src/i18n.ts:2243-2249`) |
| Automatic detection | Russianizer marker and storage hint, navigator language, document language | `ru` for Russian prefixes; otherwise `en` | Missing hints resolve to English; storage exceptions do not abort detection (`packages/i18n/src/i18n.ts:2233-2263`) |
| Hint subscription | Document mutations and storage events for the Russianizer key or a cleared storage event | Callback receives a changed detected locale | Without `MutationObserver` or a document root, only the storage listener can notify; disposer removes active observers/listeners (`packages/i18n/src/i18n.ts:2264-2285`) |

### Message helper behavior

| Helper | Accepted input | Result and fallback |
|---|---|---|
| `validationMessage` | Six literal codes and a `string[]` parameter list | Four setup codes return fixed translations; `invalid_choice` substitutes `params[0..1]`; remaining code path uses `params[0..3]` for the incompatible-setting message (`packages/i18n/src/i18n.ts:2290-2304`) |
| `stateLabel` | Any string | Translates `state_<value>` if that key exists in English; otherwise returns the input (`packages/i18n/src/i18n.ts:2305-2309`) |
| `unappliedReason` | Any string | Maps known catalog reason constants and a recognized invalid-flag format; unknown reasons pass through unchanged (`packages/i18n/src/i18n.ts:2310-2335`, `packages/settings-catalog/src/channels.ts:19`) |
| `currentStrings` | No arguments | Returns the current translations for enable, enabling, failed, and already active (`packages/i18n/src/i18n.ts:2336-2343`) |

### Catalog entries that carry UI states

The base dictionary `chromeEn`/`chromeRu` holds more than static labels; some keys are chosen by state, and the caller fills `{placeholders}` itself (`packages/i18n/src/i18n.ts:20`, `packages/i18n/src/i18n.ts:1118`).

| Keys | Where | Chosen when |
|---|---|---|
| `runCardState_*` | `packages/i18n/src/i18n.ts:84-94`, `packages/i18n/src/i18n.ts:1182-1192` | The run card maps each ended attempt state (`validation_failed`, `provider_error`, `empty_output`, `spawn_rejected`, `internal_error`) to its own label; an unmapped state falls back to `runCardState_working` (`src/rooms/runs/ui/run-card.tsx:19-23`) |
| `runCardLoadFailed`, `runCardStale` | `packages/i18n/src/i18n.ts:95-96`, `packages/i18n/src/i18n.ts:1193-1194` | The run card is offline: the first text when no card was ever loaded, the second above the last known states (`src/rooms/runs/ui/run-card.tsx:68`, `src/rooms/runs/ui/run-card.tsx:80`) |
| `runCardBackgroundFailed`, `runCardStage_memory`, `runCardStage_projectLife`, `runCardStage_docs` | `packages/i18n/src/i18n.ts:97-100`, `packages/i18n/src/i18n.ts:1195-1198` | A task has failed background stages; the card replaces `{stages}` with the stage labels (`memory-maintenance`, `project-life`, `docs-maintenance`) and shows an unknown stage name as is (`src/rooms/runs/ui/run-card.tsx:24-26`) |
| `boardLoadFailed`, `boardStale` | `packages/i18n/src/i18n-board.ts:34-35`, `packages/i18n/src/i18n-board.ts:207-208` | The task board is offline: `boardLoadFailed` while no task list was loaded, `boardStale` when the last known states stay on screen; hidden on the stats view (`src/rooms/runs/ui/task-board.tsx:215`) |
| `teamModelAsWriter`, `teamModelFromTable` | `packages/i18n/src/i18n.ts:188-189`, `packages/i18n/src/i18n.ts:1286-1287` | The team roster's model column: roles that use the task writer's model, or roles whose model is read from the role table, with `+N` for more models of the pool (`src/rooms/ui-shell/ui/tab-team.tsx:106`, `src/rooms/ui-shell/ui/tab-team.tsx:111`) |
| `roleModelsPool*` | `packages/i18n/src/i18n.ts:190-193`, `packages/i18n/src/i18n.ts:1288-1291` | A role's model pool in settings: the "Also takes" line, the single-model hint, and the add and remove button labels with `{role}` and `{model}` (`src/rooms/settings/ui/role-models.tsx:116-130`) |
| `modelOverrides*` | `packages/i18n/src/i18n.ts:194-204`, `packages/i18n/src/i18n.ts:1292-1302` | The "Reset everywhere" panel counts and resets places with own models or agents; the help text states that LP bench projects and sandboxes keep theirs (`src/rooms/settings/ui/model-overrides.tsx:66`, `src/rooms/settings/ui/model-overrides.tsx:74`) |

## Business rules

- Only English and Russian are supported by the `Locale` type (`packages/i18n/src/i18n.ts:2219-2221`).
- The Russianizer hint wins over navigator and document language; the navigator value wins over the document value when present (`packages/i18n/src/i18n.ts:2233-2242`).
- Only an explicit local-storage value of `"off"` disables the Russianizer hint, and the hint is read only when the plugin footer marker exists (`packages/i18n/src/i18n.ts:2253-2260`).
- Locale override is stored on `globalThis` as well as in module state so separate plugin bundles can observe the explicit selection (`packages/i18n/src/i18n.ts:2223-2232`).
- Known unapplied-reason strings are sourced from `UNAPPLIED_REASON`; unsupported input is preserved instead of replaced with a fabricated translation (`packages/i18n/src/i18n.ts:2310-2335`, `packages/settings-catalog/src/channels.ts:19`).

## Public API

All declarations below are exported from `i18n.ts` and re-exported by the package root (`packages/i18n/src/index.ts:1`).

| Import | Source | Purpose |
|---|---|---|
| `en`, `ru` | `packages/i18n/src/i18n.ts:2216-2217` | Complete English and Russian dictionaries |
| `I18nKey`, `Locale`, `LocalePreference` | `packages/i18n/src/i18n.ts:2219-2221` | Translation key and locale types |
| `setLocaleOverride(next)` | `packages/i18n/src/i18n.ts:2226-2232` | Set or clear explicit shared locale override |
| `localeFromSources(documentLanguage?, navigatorLanguage?, russianizerHint?)` | `packages/i18n/src/i18n.ts:2233-2242` | Resolve a locale from supplied hints |
| `detectLocale()` | `packages/i18n/src/i18n.ts:2243-2249` | Read override or browser hints |
| `detectLocaleHint()` | `packages/i18n/src/i18n.ts:2250-2263` | Read browser and Russianizer hints |
| `subscribeToLocaleHintChanges(listener)` | `packages/i18n/src/i18n.ts:2264-2285` | Listen for automatic hint changes; returns cleanup function |
| `t(key)` | `packages/i18n/src/i18n.ts:2286-2289` | Return translated string for a typed key |
| `validationMessage(code, params)` | `packages/i18n/src/i18n.ts:2290-2304` | Translate supported validation errors |
| `stateLabel(state)` | `packages/i18n/src/i18n.ts:2305-2309` | Translate known state key or preserve input |
| `unappliedReason(reason)` | `packages/i18n/src/i18n.ts:2310-2335` | Translate known setting-application reason or preserve input |
| `currentStrings()` | `packages/i18n/src/i18n.ts:2336-2343` | Return four current activation strings |

## Package shape

- `src/index.ts` is the sole package entry point (`packages/i18n/src/index.ts:1`, `packages/i18n/package.json:10-13`).
- `src/i18n.ts` merges the base dictionary, feature catalogs, and locale helpers (`packages/i18n/src/i18n.ts:1-17`, `packages/i18n/src/i18n.ts:2216-2343`).
- `src/i18n-*.ts` files hold feature-specific English and Russian pairs, with their domains identified in catalog headers (`packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-schedule.ts:1-2`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`, `packages/i18n/src/i18n-cockpit.ts:1-2`).

## Internal model

Catalogs are plain objects. The English dictionary defines the valid key union, and the Russian dictionary is assigned the mapped type `{ [K in keyof typeof en]: string }` (`packages/i18n/src/i18n.ts:2216-2221`). Runtime translation performs a direct lookup in one of those objects; interpolation is performed only by dedicated helpers such as `validationMessage`, while callers replace placeholders in ordinary catalog strings when needed (`packages/i18n/src/i18n.ts:2286-2304`).

## Dependencies

`i18n.ts` imports `UNAPPLIED_REASON` from `@lane-pilot/settings-catalog`; all other imports are local catalog modules (`packages/i18n/src/i18n.ts:1-17`). Consumers include the root plugin app and room modules in the monorepo (`app.tsx:3`, `src/rooms/runs/server/rpc/runs.ts:1`).

## Gotchas

See [Gotchas](../gotchas.md) for key collision behavior, override precedence, and unchanged fallback values.

<!-- lane-pilot:backlinks -->
## Referenced by

- [i18n workspace overview](../overview.md)

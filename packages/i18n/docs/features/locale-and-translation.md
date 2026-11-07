---
title: Locale resolution and translation
type: component
created: 2026-10-24
updated: 2026-11-07
status: active
confidence: high
tags: [i18n, locale, translations]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-errands.ts
  - packages/i18n/src/i18n-agent-labels.ts
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
  - packages/i18n/src/i18n-workflow-library.ts
  - packages/i18n/src/i18n-workflow-export.ts
  - packages/i18n/src/i18n-workflow-map.ts
  - packages/i18n/src/i18n-workflow-ops.ts
  - packages/i18n/src/i18n-workflows.ts
  - packages/i18n/src/i18n-owned.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n-graph.ts
  - packages/i18n/src/i18n-agent-labels.ts
  - src/rooms/native-agent/agent-display.ts
  - src/rooms/workflow/ui/workflows.tsx
  - src/rooms/workflow/ui/workflow-detail.tsx
  - src/rooms/cockpit/ui/screens-work.tsx
  - src/rooms/native-install/native-install-lifecycle.ts
  - src/rooms/runs/ui/runs-service.tsx
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
  - src/rooms/workflow/ui/workflow-actions.tsx
  - src/rooms/settings/setting-copy.ts
  - src/rooms/workflow/ui/workflow-library-parts.tsx
---
# Locale resolution and translation

TL;DR: This component merges English and Russian UI catalogs, selects a locale from the global override, then the module-local override, then browser hints, and exposes typed translation and label helpers (`packages/i18n/src/i18n.ts:2481-2487`, `packages/i18n/src/i18n.ts:2492-2555`).

## Purpose

The component provides shared text for the plugin UI. `I18nKey` combines the English dictionary keys with the agent-label keys, `Locale` is `"en" | "ru"`, and `LocalePreference` is `"auto" | Locale`; `ru` is constrained to the keys of `en` (`packages/i18n/src/i18n.ts:2482-2487`).

The agent-label keys are added to `I18nKey` explicitly (`packages/i18n/src/i18n.ts:2485`).

The separate `agentLabelEn` catalog defines those keys (`packages/i18n/src/i18n-agent-labels.ts:2`).

Feature catalogs partition strings by workflow screens, library filters and views, export dialog, graph map, editor, operations, model view, canvas, task board, schedules, tabs, self-improvement, errands, role models, fields, cockpit, and agent picker names (`packages/i18n/src/i18n-workflows.ts:2`, `packages/i18n/src/i18n-workflow-library.ts:1-20`, `packages/i18n/src/i18n-workflow-export.ts:1-26`, `packages/i18n/src/i18n-workflow-map.ts:1-41`, `packages/i18n/src/i18n-workflow-editor.ts:2`, `packages/i18n/src/i18n-workflow-ops.ts:2`, `packages/i18n/src/i18n-workflow-models.ts:2`, `packages/i18n/src/i18n-workflow-canvas.ts:2`, `packages/i18n/src/i18n-board.ts:2`, `packages/i18n/src/i18n-schedule.ts:2`, `packages/i18n/src/i18n-tabs.ts:2`, `packages/i18n/src/i18n-improvement.ts:2`, `packages/i18n/src/i18n-errands.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:5`, `packages/i18n/src/i18n-fields.ts:1`, `packages/i18n/src/i18n-cockpit.ts:2`, `packages/i18n/src/i18n-agent-labels.ts:2`).

The role-model catalog contains the API reconnaissance role name and rationale, plus the episode analyst and night wall hunter names and rationales, in English and Russian (`packages/i18n/src/i18n-role-models.ts:38-44`, `packages/i18n/src/i18n-role-models.ts:88-95`, `packages/i18n/src/i18n-role-models.ts:145-151`, `packages/i18n/src/i18n-role-models.ts:195-202`). It also contains the lead role and four errand-kind rows in both languages (`packages/i18n/src/i18n-role-models.ts:27`, `packages/i18n/src/i18n-role-models.ts:64`, `packages/i18n/src/i18n-role-models.ts:43-48`, `packages/i18n/src/i18n-role-models.ts:150-155`).

The fields catalog includes labels and descriptions for errand episode collection and the `shadow`/`active` process-key modes (`packages/i18n/src/i18n-fields.ts:1058-1061`, `packages/i18n/src/i18n-fields.ts:2120-2123`). The base dictionary defines the `enumEpisodesProcessKeyShadow` and `enumEpisodesProcessKeyActive` enum labels (`packages/i18n/src/i18n.ts:983-984`, `packages/i18n/src/i18n.ts:2211-2212`).

The errands catalog includes labels for checked and unchecked outcomes in both languages (`packages/i18n/src/i18n-errands.ts:22`, `packages/i18n/src/i18n-errands.ts:50`).

## How it works

1. The package entry point re-exports `i18n.ts` (`packages/i18n/src/index.ts:1`).
2. `i18n.ts` imports `UNAPPLIED_REASON` from `settings-catalog` (`packages/i18n/src/i18n.ts:1`).
3. `en` and `ru` merge their corresponding catalogs in the same order. `export` and `map` are spread after `agentLabel`; `ru` uses the English dictionary's keys as its type (`packages/i18n/src/i18n.ts:2481-2482`).
4. `detectLocale` checks the global override shared across bundles, then the module-local override, then calls `detectLocaleHint` (`packages/i18n/src/i18n.ts:2509-2515`).
5. `detectLocaleHint` recognizes the Russianizer only when its footer marker exists; local storage value `"off"` disables that hint, while other values leave it enabled. Storage access exceptions are caught (`packages/i18n/src/i18n.ts:2516-2529`).
6. `localeFromSources` chooses Russianizer hint first, then a non-empty navigator language, then a non-default document language, and otherwise English. A recognized language prefix `ru` maps to Russian; other supplied languages map to English (`packages/i18n/src/i18n.ts:2499-2508`).
7. `t` returns the key's value from the selected dictionary; `agentLabel` keys are real keys of both dictionaries, so `t` reads them like any other key. `subscribeToLocaleHintChanges` watches document mutations and matching storage events, notifies only when its detected hint changes, and returns a disposer that disconnects both listeners (`packages/i18n/src/i18n.ts:2530-2555`).
8. Specialized helpers map validation codes, state names, and unapplied reasons to translated strings; unknown state names and unknown reason formats are returned unchanged (`packages/i18n/src/i18n.ts:2556-2601`).

### Locale modes

| Mode | Input and precedence | Output | Failure or fallback |
|---|---|---|---|
| Explicit override | `setLocaleOverride("en" | "ru")`; global override is checked before module-local state | Forced dictionary locale | Passing `null` clears both override values, after which detection uses hints (`packages/i18n/src/i18n.ts:2492-2498`) |
| Automatic detection | Russianizer marker and storage hint, navigator language, document language | `ru` for Russian prefixes; otherwise `en` | Missing hints resolve to English; storage exceptions do not abort detection (`packages/i18n/src/i18n.ts:2499-2529`) |
| Hint subscription | Document mutations and storage events for the Russianizer key or a cleared storage event | Callback receives a changed detected locale | Without `MutationObserver` or a document root, only the storage listener can notify; disposer removes active observers/listeners (`packages/i18n/src/i18n.ts:2530-2551`) |

### Message helper behavior

| Helper | Accepted input | Result and fallback |
|---|---|---|
| `validationMessage` | Six literal codes and a `string[]` parameter list | Four setup codes return fixed translations; `invalid_choice` substitutes `params[0..1]`; remaining code path uses `params[0..3]` for the incompatible-setting message (`packages/i18n/src/i18n.ts:2556-2570`) |
| `stateLabel` | Any string | Translates `state_<value>` if that key exists in English; otherwise returns the input (`packages/i18n/src/i18n.ts:2571-2575`) |
| `unappliedReason` | Any string | Maps known catalog reason constants and a recognized invalid-flag format; unknown reasons pass through unchanged (`packages/i18n/src/i18n.ts:2576-2601`) |
| `currentStrings` | No arguments | Returns the current translations for enable, enabling, failed, and already active (`packages/i18n/src/i18n.ts:2602-2609`) |

### Catalog entries that carry UI states

The base dictionaries are declared as `chromeEn` and `chromeRu` (`packages/i18n/src/i18n.ts:25`, `packages/i18n/src/i18n.ts:1253`).

`t` reads the value from the selected dictionary (`packages/i18n/src/i18n.ts:2552-2555`).

The run card selects labels by attempt state and maps background-stage labels before rendering them (`src/rooms/runs/ui/run-card.tsx:19-27`).

| Keys | Where | Chosen when |
|---|---|---|
| `runCardState_*` | `packages/i18n/src/i18n.ts:86-96` | The run card maps each ended attempt state (`validation_failed`, `provider_error`, `empty_output`, `spawn_rejected`, `internal_error`) to its own label; an unmapped state falls back to `runCardState_working` (`src/rooms/runs/ui/run-card.tsx:19-24`) |
| `runCardLoadFailed`, `runCardStale` | `packages/i18n/src/i18n.ts:97-98` | The run card shows the load-failure text when no card was loaded and the stale text above the last known states (`src/rooms/runs/ui/run-card.tsx:70`, `src/rooms/runs/ui/run-card.tsx:86`) |
| `runCardBackgroundFailed`, `runCardStage_memory`, `runCardStage_projectLife`, `runCardStage_docs` | `packages/i18n/src/i18n.ts:99-102` | A task has failed background stages; the card replaces `{stages}` with the stage labels (`memory-maintenance`, `project-life`, `docs-maintenance`) and shows an unknown stage name as is (`src/rooms/runs/ui/run-card.tsx:25-27`) |
| `boardLoadFailed`, `boardStale` | `packages/i18n/src/i18n-board.ts:34-35`, `packages/i18n/src/i18n-board.ts:207-208` | The task board is offline: `boardLoadFailed` while no task list was loaded, `boardStale` when the last known states stay on screen; hidden on the stats view (`src/rooms/runs/ui/task-board.tsx:215`) |
| `teamModelAsWriter`, `teamModelFromTable` | `packages/i18n/src/i18n.ts:192-193`, `packages/i18n/src/i18n.ts:1420-1421` | The team roster's model column: roles that use the task writer's model, or roles whose model is read from the role table, with `+N` for additional role models (`src/rooms/ui-shell/ui/tab-team.tsx:132`, `src/rooms/ui-shell/ui/tab-team.tsx:141`) |
| `roleModelsPool*`, `teamPoolNone` | `packages/i18n/src/i18n.ts:194-198`, `packages/i18n/src/i18n.ts:1422-1426` | Fallback list labels in settings, its no-fallback hint, and add/remove button labels with `{role}` and `{model}` (`src/rooms/settings/ui/role-models.tsx:116-130`) |
| `wfSuccessRate`, `wfOutcomeCounts` | `packages/i18n/src/i18n-workflows.ts:27-28`, `packages/i18n/src/i18n-workflows.ts:169-170` | The catalog defines the work-done percentage and outcome-count labels; the workflow library renders `wfSuccessRate` only when `stats.successRate` is non-null (`src/rooms/workflow/ui/workflow-library-parts.tsx:56`) |
| `wfRunStatus_not_verified` | `packages/i18n/src/i18n-workflows.ts:56`, `packages/i18n/src/i18n-workflows.ts:198` | A run closed as not verified gets its own label ("Not verified"); the run detail status map includes it (`src/rooms/workflow/ui/workflow-detail.tsx:35`) |
| `agentDisplay*` | `packages/i18n/src/i18n-agent-labels.ts:2-15`, `packages/i18n/src/i18n-agent-labels.ts:17-30` | The agent picker shows the translated name for a stock agent only while its stored description still equals the bundled one; otherwise it shows the description (`src/rooms/native-agent/agent-display.ts:87-106`). Twelve agents have keys here — the eleven ported from Claude Lane (advisor, AI researcher, animator, doc classifier, domain researcher, eval auditor, eval planner, model selector, memory curator, check auditor, UI researcher) and the lead, Shturman — and the picker maps each stock id to its key (`packages/i18n/src/i18n-agent-labels.ts:3-14`, `src/rooms/native-agent/agent-display.ts:61-85`) |
| `ckStopPhase`, `ckUseful`, `ckLimits`, `ckLessonDraft` | `packages/i18n/src/i18n-cockpit.ts:46`, `packages/i18n/src/i18n-cockpit.ts:53-55`, `packages/i18n/src/i18n-cockpit.ts:172`, `packages/i18n/src/i18n-cockpit.ts:179-181` | Cockpit work screen: the stop-the-phase button, the two acceptance checkboxes (result is useful, limits and way back are accepted) and the lesson draft line, each shown at the matching owner-word turn (`src/rooms/cockpit/ui/screens-work.tsx:95-100`, `src/rooms/cockpit/ui/screens-work.tsx:116`) |
| `nativeInstallFailed` | `packages/i18n/src/i18n.ts:146`, `packages/i18n/src/i18n.ts:1374` | The text of the error thrown when the Lane Pilot install reports a failure that differs from the previous one; `{error}` is filled by the caller (`src/rooms/native-install/native-install-lifecycle.ts:96`) |
| `cliOnlyTitle`, `cliOnlyHelp`, `settingOpsCliHelp`, `settingOpsPoolHelp` | `packages/i18n/src/i18n-improvement.ts:16-17`, `packages/i18n/src/i18n-improvement.ts:200-201`, `packages/i18n/src/i18n.ts:861-862`, `packages/i18n/src/i18n.ts:2089-2090` | Retired Lane Stack CLI flags are described as not applied with their stored values kept, in a disclosure that keeps the retired rows out of the live ops section (`src/rooms/runs/ui/runs-service.tsx:197-200`); pool-size settings use the native run-policy help (`src/rooms/settings/setting-copy.ts:113`, `src/rooms/settings/setting-copy.ts:117`) |
| `modelOverrides*` | `packages/i18n/src/i18n.ts:199-212`, `packages/i18n/src/i18n.ts:1427-1440` | The "Reset everywhere" panel counts and resets places with own models or agents; the help text states that LP bench projects and sandboxes keep theirs (`src/rooms/settings/ui/model-overrides.tsx:66`, `src/rooms/settings/ui/model-overrides.tsx:74`) |

## Business rules

- Only English and Russian are supported by the `Locale` type (`packages/i18n/src/i18n.ts:2486`).
- The Russianizer hint wins over navigator and document language; the navigator value wins over the document value when present (`packages/i18n/src/i18n.ts:2499-2508`).
- Only an explicit local-storage value of `"off"` disables the Russianizer hint, and the hint is read only when the plugin footer marker exists (`packages/i18n/src/i18n.ts:2521-2526`).
- `detectLocale` checks a valid global override before module-local state and automatic hints (`packages/i18n/src/i18n.ts:2509-2514`).
- `setLocaleOverride` writes or clears both override values so separate plugin bundles observe explicit selections (`packages/i18n/src/i18n.ts:2492-2498`).
- Known unapplied-reason strings are sourced from `UNAPPLIED_REASON`; unsupported input is preserved instead of replaced with a fabricated translation (`packages/i18n/src/i18n.ts:2576-2601`). The reason constants are declared in settings-catalog (`packages/settings-catalog/src/channels.ts:19`).

## Public API

All declarations below are exported from `i18n.ts` and re-exported by the package root (`packages/i18n/src/index.ts:1`).

| Import | Source | Purpose |
|---|---|---|
| `en`, `ru` | `packages/i18n/src/i18n.ts:2481-2482` | Complete English and Russian dictionaries |
| `I18nKey`, `Locale`, `LocalePreference` | `packages/i18n/src/i18n.ts:2485-2487` | Translation key and locale types |
| `setLocaleOverride(next)` | `packages/i18n/src/i18n.ts:2492-2498` | Set or clear explicit shared locale override |
| `localeFromSources(documentLanguage?, navigatorLanguage?, russianizerHint?)` | `packages/i18n/src/i18n.ts:2499-2508` | Resolve a locale from supplied hints |
| `detectLocale()` | `packages/i18n/src/i18n.ts:2509-2515` | Read override or browser hints |
| `detectLocaleHint()` | `packages/i18n/src/i18n.ts:2516-2529` | Read browser and Russianizer hints |
| `subscribeToLocaleHintChanges(listener)` | `packages/i18n/src/i18n.ts:2530-2551` | Listen for automatic hint changes; returns cleanup function |
| `t(key)` | `packages/i18n/src/i18n.ts:2552-2555` | Return translated string for a typed key |
| `validationMessage(code, params)` | `packages/i18n/src/i18n.ts:2556-2570` | Translate supported validation errors |
| `stateLabel(state)` | `packages/i18n/src/i18n.ts:2571-2575` | Translate known state key or preserve input |
| `unappliedReason(reason)` | `packages/i18n/src/i18n.ts:2576-2601` | Translate known setting-application reason or preserve input |
| `currentStrings()` | `packages/i18n/src/i18n.ts:2602-2609` | Return four current activation strings |

## Package shape

- `src/index.ts` is the sole package entry point (`packages/i18n/src/index.ts:1`, `packages/i18n/package.json:10-13`).
- `src/i18n.ts` merges the base dictionary, feature catalogs, and locale helpers (`packages/i18n/src/i18n.ts:1-23`, `packages/i18n/src/i18n.ts:2481-2609`).
- `src/i18n-*.ts` files hold feature-specific English and Russian pairs, with their domains identified in catalog headers (`packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-schedule.ts:1-2`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`, `packages/i18n/src/i18n-cockpit.ts:1-2`).

## Internal model

Catalogs are plain objects. `I18nKey` combines the English dictionary keys with `agentLabelEn` keys, and the Russian dictionary is assigned the mapped type `{ [K in keyof typeof en]: string }` (`packages/i18n/src/i18n.ts:2481-2487`). Runtime translation performs a direct lookup in the selected dictionary (`packages/i18n/src/i18n.ts:2552-2555`). `validationMessage` performs placeholder replacement for validation errors (`packages/i18n/src/i18n.ts:2556-2570`).

## Dependencies

`i18n.ts` imports `UNAPPLIED_REASON` from `@lane-pilot/settings-catalog` (`packages/i18n/src/i18n.ts:1`).

Its other imports are local catalog modules (`packages/i18n/src/i18n.ts:2-23`).

The root plugin app imports the package API (`app.tsx:3`). A room server module also imports the package API (`src/rooms/runs/server/rpc/runs.ts:1`).

## Gotchas

See [Gotchas](../gotchas.md) for key collision behavior, override precedence, and unchanged fallback values.

<!-- lane-pilot:backlinks -->
## Referenced by

- [i18n workspace overview](../overview.md)

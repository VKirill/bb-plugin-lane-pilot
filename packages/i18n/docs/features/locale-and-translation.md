---
title: Locale resolution and translation
type: component
created: 2026-10-24
updated: 2026-11-23
status: active
confidence: high
tags: [i18n, locale, translations]
sources:
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/role-names.ts
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
  - src/rooms/contracts/agent-display.ts
  - src/rooms/workflow/ui/workflows.tsx
  - src/rooms/workflow/ui/workflow-detail.tsx
  - src/rooms/cockpit/ui/screens-work.tsx
  - src/rooms/native-install/native-install-lifecycle.ts
  - src/rooms/pages/service-segment.tsx
  - packages/i18n/tests/i18n.test.ts
  - src/rooms/runs/ui/run-card.tsx
  - src/rooms/runs/ui/task-board.tsx
  - src/rooms/runs/ui/workflow-run-steps.tsx
  - src/rooms/acceptance/ui/acceptance-card.tsx
  - src/rooms/work-graph/ui/work-breakdown.tsx
  - src/rooms/cockpit/ui/screens-day.tsx
  - src/rooms/cockpit/ui/screens-ops.tsx
  - src/rooms/pages/tab-team.tsx
  - src/rooms/pages/role-models.tsx
  - src/rooms/ui-shell/ui/model-overrides.tsx
  - packages/settings-catalog/src/channels.ts
  - packages/i18n/package.json
  - app.tsx
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/workflow/ui/workflow-actions.tsx
  - src/rooms/ui-shell/ui/setting-copy.ts
  - src/rooms/workflow/ui/workflow-library-parts.tsx
  - src/rooms/runs/ui/thread-live.tsx
  - src/rooms/pages/tab-overview.tsx
---
# Locale resolution and translation

TL;DR: This component merges English and Russian UI catalogs, selects a locale from the global override, then the module-local override, then browser hints, and exposes typed translation and label helpers (`packages/i18n/src/i18n.ts:2515-2521`, `packages/i18n/src/i18n.ts:2526-2648`).

## Purpose

The component provides shared text for the plugin UI. `I18nKey` combines the English dictionary keys with the agent-label keys, `Locale` is `"en" | "ru"`, and `LocalePreference` is `"auto" | Locale`; `ru` is constrained to the keys of `en` (`packages/i18n/src/i18n.ts:2519-2521`, `packages/i18n/src/i18n.ts:2516`).

The agent-label keys are added to `I18nKey` explicitly (`packages/i18n/src/i18n.ts:2519`).

The separate `agentLabelEn` catalog defines those keys (`packages/i18n/src/i18n-agent-labels.ts:3`).

Feature catalogs partition strings by workflow screens, library filters and views, export dialog, graph map, editor, operations, model view, canvas, task board, schedules, tabs, self-improvement, errands, role models, fields, cockpit, and agent picker names. The library, export, and map catalogs each define a Marketing category in English and Russian (`packages/i18n/src/i18n-workflow-library.ts:2-6`, `packages/i18n/src/i18n-workflow-library.ts:23-27`, `packages/i18n/src/i18n-workflow-export.ts:18-20`, `packages/i18n/src/i18n-workflow-export.ts:45-47`, `packages/i18n/src/i18n-workflow-map.ts:6-10`, `packages/i18n/src/i18n-workflow-map.ts:48-52`). The base dictionary adds the bilingual access name and purpose for the Growth marketer specialist (`packages/i18n/src/i18n.ts:1236-1237`, `packages/i18n/src/i18n.ts:2481-2482`) and for the chat-digestion (`digest-light`, `digest-analyst`) and graph-evolution (`evolve-planner`, `evolve-critic`, `evolve-architect`, `evolve-auditor`) roles (`packages/i18n/src/i18n.ts:1202-1213`, `packages/i18n/src/i18n.ts:2447-2458`). Role display keys in `i18n.ts`, `i18n-agent-labels.ts`, and `i18n-role-models.ts` read their strings from the canonical role-name map via `roleNameEn` and `roleNameRu` (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n-agent-labels.ts:1`, `packages/i18n/src/i18n-role-models.ts:1`); see [Canonical role names](role-names.md). Catalog declarations include `packages/i18n/src/i18n-workflows.ts:2`, `packages/i18n/src/i18n-workflow-library.ts:1-20`, `packages/i18n/src/i18n-workflow-export.ts:1-26`, `packages/i18n/src/i18n-workflow-map.ts:1-41`, `packages/i18n/src/i18n-workflow-editor.ts:2`, `packages/i18n/src/i18n-workflow-ops.ts:2`, `packages/i18n/src/i18n-workflow-models.ts:2`, `packages/i18n/src/i18n-workflow-canvas.ts:2`, `packages/i18n/src/i18n-board.ts:2`, `packages/i18n/src/i18n-schedule.ts:2`, `packages/i18n/src/i18n-tabs.ts:2`, `packages/i18n/src/i18n-improvement.ts:2`, `packages/i18n/src/i18n-errands.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:6`, `packages/i18n/src/i18n-fields.ts:1`, `packages/i18n/src/i18n-cockpit.ts:2`, `packages/i18n/src/i18n-agent-labels.ts:3`.

The role-model catalog contains Growth marketer's name and rationale in both languages (`packages/i18n/src/i18n-role-models.ts:62`, `packages/i18n/src/i18n-role-models.ts:79`, `packages/i18n/src/i18n-role-models.ts:185`, `packages/i18n/src/i18n-role-models.ts:202`). It also contains the API reconnaissance role name and rationale, plus the episode analyst, night wall hunter, chat-digestion (`digest-light`, `digest-analyst`), and graph-evolution (`evolve-planner`, `evolve-critic`, `evolve-architect`, `evolve-auditor`) names and rationales, in English and Russian (`packages/i18n/src/i18n-role-models.ts:40-52`, `packages/i18n/src/i18n-role-models.ts:99-111`, `packages/i18n/src/i18n-role-models.ts:163-175`, `packages/i18n/src/i18n-role-models.ts:222-234`). It also contains the lead role, the light plan-critic role (`plan-critic-light`), and four errand-kind rows in both languages (`packages/i18n/src/i18n-role-models.ts:28`, `packages/i18n/src/i18n-role-models.ts:32`, `packages/i18n/src/i18n-role-models.ts:75`, `packages/i18n/src/i18n-role-models.ts:91`, `packages/i18n/src/i18n-role-models.ts:53-56`, `packages/i18n/src/i18n-role-models.ts:151`, `packages/i18n/src/i18n-role-models.ts:155`, `packages/i18n/src/i18n-role-models.ts:176-179`, `packages/i18n/src/i18n-role-models.ts:198`, `packages/i18n/src/i18n-role-models.ts:214`).

The fields catalog includes labels and descriptions for merged worktree cleanup age (`field_s624`, seven-day default), errand episode collection and its `shadow`/`active` process-key modes, the writer session turn ceiling with a five-turn default, and memory search judge settings (`field_s617`–`field_s621`) alongside `sensitive` owner-words copy (`field_s609`) and updated writer-question routing copy (`field_s585`–`field_s586`) (`packages/i18n/src/i18n-fields.ts:1000-1003`, `packages/i18n/src/i18n-fields.ts:1018-1019`, `packages/i18n/src/i18n-fields.ts:1034-1035`, `packages/i18n/src/i18n-fields.ts:1038-1041`, `packages/i18n/src/i18n-fields.ts:1048-1059`, `packages/i18n/src/i18n-fields.ts:2060-2063`, `packages/i18n/src/i18n-fields.ts:2078-2079`, `packages/i18n/src/i18n-fields.ts:2094-2095`, `packages/i18n/src/i18n-fields.ts:2098-2101`, `packages/i18n/src/i18n-fields.ts:2108-2119`). The base dictionary defines the `enumEpisodesProcessKeyShadow` and `enumEpisodesProcessKeyActive` enum labels as well as plan-critique revision routing (`planner` default vs `pm`), revision round count, owned-path count threshold (`8` default, `0` off), and the `paths` field unit (`packages/i18n/src/i18n.ts:743`, `packages/i18n/src/i18n.ts:812-817`, `packages/i18n/src/i18n.ts:971-972`, `packages/i18n/src/i18n.ts:986-987`, `packages/i18n/src/i18n.ts:2001`, `packages/i18n/src/i18n.ts:2057-2062`, `packages/i18n/src/i18n.ts:2216-2217`, `packages/i18n/src/i18n.ts:2231-2232`).

The errands catalog includes labels for checked and unchecked outcomes and identifies the PM, brief, and schedule as kind sources (`packages/i18n/src/i18n-errands.ts:22-24`, `packages/i18n/src/i18n-errands.ts:50-52`).

## How it works

1. The package entry point re-exports `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`).
2. `i18n.ts` imports role-name helpers from `./role-names` and `UNAPPLIED_REASON` from `settings-catalog` (`packages/i18n/src/i18n.ts:1-2`).
3. `en` and `ru` merge their corresponding catalogs in the same order. `export` and `map` are spread after `agentLabel`; `ru` uses the English dictionary's keys as its type (`packages/i18n/src/i18n.ts:2515-2516`).
4. `detectLocale` checks the global override shared across bundles, then the module-local override, then calls `detectLocaleHint` (`packages/i18n/src/i18n.ts:2543-2548`).
5. `detectLocaleHint` recognizes the Russianizer only when its footer marker exists; local storage value `"off"` disables that hint, while other values leave it enabled. Storage access exceptions are caught (`packages/i18n/src/i18n.ts:2550-2562`).
6. `localeFromSources` chooses Russianizer hint first, then a non-empty navigator language, then a non-default document language, and otherwise English. A recognized language prefix `ru` maps to Russian; other supplied languages map to English (`packages/i18n/src/i18n.ts:2533-2541`).
7. `t` reads the requested key from `ru` when the detected locale is Russian and from `en` otherwise; `agentLabel` keys are real keys of both dictionaries. `subscribeToLocaleHintChanges` watches document mutations and matching storage events, notifies only when its detected hint changes, and returns a disposer that disconnects both listeners (`packages/i18n/src/i18n.ts:2586-2588`, `packages/i18n/src/i18n.ts:2564-2584`).
8. Specialized helpers map validation codes, state names, unapplied reasons, and role IDs to translated strings; unknown state names, unknown reason formats, and unknown role IDs are returned unchanged (`packages/i18n/src/i18n.ts:2590-2648`).

### Locale modes

| Mode | Input and precedence | Output | Failure or fallback |
|---|---|---|---|
| Explicit override | `setLocaleOverride("en" | "ru")`; global override is checked before module-local state | Forced dictionary locale | Passing `null` clears both override values, after which detection uses hints (`packages/i18n/src/i18n.ts:2526-2531`) |
| Automatic detection | Russianizer marker and storage hint, navigator language, document language | `ru` for Russian prefixes; otherwise `en` | Missing hints resolve to English; storage exceptions do not abort detection (`packages/i18n/src/i18n.ts:2533-2562`) |
| Hint subscription | Document mutations and storage events for the Russianizer key or a cleared storage event | Callback receives a changed detected locale | Without `MutationObserver` or a document root, only the storage listener can notify; disposer removes active observers/listeners (`packages/i18n/src/i18n.ts:2564-2584`) |

### Message helper behavior

| Helper | Accepted input | Result and fallback |
|---|---|---|
| `validationMessage` | Six literal codes and a `string[]` parameter list | Four setup codes return fixed translations; `invalid_choice` substitutes `params[0..1]`; remaining code path uses `params[0..3]` for the incompatible-setting message (`packages/i18n/src/i18n.ts:2590-2603`) |
| `stateLabel` | Any string | Translates `state_<value>` if that key exists in English; otherwise returns the input (`packages/i18n/src/i18n.ts:2605-2608`) |
| `unappliedReason` | Any string | Maps known catalog reason constants and a recognized invalid-flag format; unknown reasons pass through unchanged (`packages/i18n/src/i18n.ts:2610-2634`) |
| `currentStrings` | No arguments | Returns the current translations for enable, enabling, failed, and already active (`packages/i18n/src/i18n.ts:2636-2643`) |
| `roleName` | Any role ID string | Calls `roleDisplayName(id, detectLocale())` against [Canonical role names](role-names.md); unknown role IDs pass through unchanged (`packages/i18n/src/i18n.ts:2646-2648`) |

### Catalog entries that carry UI states

The base dictionaries are declared as `chromeEn` and `chromeRu` (`packages/i18n/src/i18n.ts:25`, `packages/i18n/src/i18n.ts:1270`).

`t` selects `ru[key]` or `en[key]` from the detected locale (`packages/i18n/src/i18n.ts:2586-2588`).

The run card selects labels by attempt state and maps background-stage labels before rendering them (`src/rooms/runs/ui/run-card.tsx:19-27`).

| Keys | Where | Chosen when |
|---|---|---|
| `runCardState_*` | `packages/i18n/src/i18n.ts:89-99` | The run card maps each ended attempt state (`validation_failed`, `provider_error`, `empty_output`, `spawn_rejected`, `internal_error`) to its own label; an unmapped state falls back to `runCardState_working` (`src/rooms/runs/ui/run-card.tsx:19-24`) |
| `runCardLoadFailed`, `runCardStale` | `packages/i18n/src/i18n.ts:100-101` | The run card shows the load-failure text when no card was loaded and the stale text above the last known states (`src/rooms/runs/ui/run-card.tsx:70`, `src/rooms/runs/ui/run-card.tsx:86`) |
| `runCardBackgroundFailed`, `runCardStage_memory`, `runCardStage_projectLife`, `runCardStage_docs` | `packages/i18n/src/i18n.ts:102-105` | A task has failed background stages; the card replaces `{stages}` with the stage labels (`memory-maintenance`, `project-life`, `docs-maintenance`) and shows an unknown stage name as is (`src/rooms/runs/ui/run-card.tsx:25-27`) |
| `helperRole_emergencyWriter`, `helperRole_apiRecon` | `packages/i18n/src/i18n.ts:110-111`, `packages/i18n/src/i18n.ts:1355-1356` | Helper role labels sourced from `ROLE_NAMES` for emergency writer and API reconnaissance threads |
| `policyDifferences`, `policyDifference`, `policyUnavailable`, `policyNoLimit` | `packages/i18n/src/i18n.ts:139-142`, `packages/i18n/src/i18n.ts:1384-1387` | Overview panel comparing frozen run settings with the next activation policy; formats `{key}`, `{current}`, and `{next}`, uses `policyNoLimit` for `null` bounds, and shows `policyUnavailable` when the policy could not be read (`src/rooms/pages/tab-overview.tsx:130-138`) |
| `boardLoadFailed`, `boardStale` | `packages/i18n/src/i18n-board.ts:46-47`, `packages/i18n/src/i18n-board.ts:256-257` | The task board is offline: `boardLoadFailed` while no task list was loaded, `boardStale` when the last known states stay on screen; hidden on the stats view (`src/rooms/runs/ui/task-board.tsx:235`) |
| `boardKindPhases`, `boardKindPhase`, `boardKindBatch`, `boardHeld`, `boardGates`, `boardGate_*`, `boardWave` | `packages/i18n/src/i18n-board.ts:9-17`, `packages/i18n/src/i18n-board.ts:208-216` | The task board labels phase and batch entries, and labels held state, failed discussion/plan/design gates, and wave position (`src/rooms/runs/ui/task-board.tsx:114-120`, `src/rooms/runs/ui/task-board.tsx:206`) |
| `boardStepResults`, `stage_state_succeeded`, `stage_state_canceled`, `stage_state_waiting` | `packages/i18n/src/i18n-board.ts:44`, `packages/i18n/src/i18n-board.ts:182-184`, `packages/i18n/src/i18n-board.ts:254`, `packages/i18n/src/i18n-board.ts:381-383` | Workflow cards render a Step results disclosure (`src/rooms/runs/ui/task-board.tsx:453`, `src/rooms/runs/ui/workflow-run-steps.tsx:32`) and translate engine step states (`succeeded`, `canceled`, `waiting`) via `stage_state_*` (`src/rooms/runs/ui/workflow-run-steps.tsx:15`) |
| `accStop` | `packages/i18n/src/i18n-board.ts:110`, `packages/i18n/src/i18n-board.ts:240` | The acceptance card shows the translated Stop control when its `onStop` callback is present (`src/rooms/acceptance/ui/acceptance-card.tsx:68`, `src/rooms/acceptance/ui/acceptance-card.tsx:230`) |
| `teamModelAsWriter`, `teamModelFromTable` | `packages/i18n/src/i18n.ts:201-202`, `packages/i18n/src/i18n.ts:1446-1447` | The team roster's model column: roles that use the task writer's model, or roles whose model is read from the role table, with `+N` for additional role models (`src/rooms/pages/tab-team.tsx:135-146`) |
| `roleModelsPool*`, `teamPoolNone` | `packages/i18n/src/i18n.ts:203-207`, `packages/i18n/src/i18n.ts:1448-1452` | Fallback list labels in settings, its no-fallback hint, and add/remove button labels with `{role}` and `{model}` (`src/rooms/pages/role-models.tsx:116-131`) |
| `wfSuccessRate`, `wfOutcomeCounts` | `packages/i18n/src/i18n-workflows.ts:27-28`, `packages/i18n/src/i18n-workflows.ts:169-170` | The catalog defines the work-done percentage and outcome-count labels; the workflow library renders `wfSuccessRate` only when `stats.successRate` is non-null (`src/rooms/workflow/ui/workflow-library-parts.tsx:56`) |
| `wfRunStatus_not_verified` | `packages/i18n/src/i18n-workflows.ts:56`, `packages/i18n/src/i18n-workflows.ts:198` | A run closed as not verified gets its own label ("Not verified"); the run detail status map includes it (`src/rooms/workflow/ui/workflow-detail.tsx:36`) |
| `agentDisplay*` | `packages/i18n/src/i18n-agent-labels.ts:3-17`, `packages/i18n/src/i18n-agent-labels.ts:19-33` | The agent picker shows the translated name for a stock agent only while its stored description still equals the bundled one; otherwise it shows the description (`src/rooms/contracts/agent-display.ts:100-108`). Thirteen agent names have keys here—eleven ported from Claude Lane, the lead, and Growth marketer—populated via `roleNameEn` (`packages/i18n/src/i18n-agent-labels.ts:4-16`) from `ROLE_NAMES` (`packages/i18n/src/role-names.ts:22-115`), and mapped from stock agent IDs in `STOCK_LABEL_KEYS` (`src/rooms/contracts/agent-display.ts:63-92`). |
| `ckScreen_rules`, `ckSwitches`, `ckHaz_*`, `ckSw_*`, `ckDaysShort`, `ckOn`, `ckOff`, `ckFallback_*` | `packages/i18n/src/i18n-cockpit.ts:21-34`, `packages/i18n/src/i18n-cockpit.ts:230-249` | The Rules-screen catalog supplies bilingual text for the screen name, hazard descriptions, switch labels, on/off values, disarm duration unit, and fallback timing labels |
| `ckShipLead` | `packages/i18n/src/i18n-cockpit.ts:145`, `packages/i18n/src/i18n-cockpit.ts:354` | The Ship screen copy says the ship workflow validates the phase, opens a clean PR branch, then pushes the branch and opens the pull request itself; the Ship screen renders this text above its workflow buttons (`src/rooms/cockpit/ui/screens-ops.tsx:147-162`) |
| `ckStopPhase`, `ckUseful`, `ckLimits`, `ckLessonDraft` | `packages/i18n/src/i18n-cockpit.ts:70-79`, `packages/i18n/src/i18n-cockpit.ts:279-288` | Cockpit work screen: the stop-the-phase button, the two acceptance checkboxes (result is useful, limits and way back are accepted) and the lesson draft line, each shown at the matching owner-word turn (`src/rooms/cockpit/ui/screens-work.tsx:182`, `src/rooms/cockpit/ui/screens-work.tsx:193-194`, `src/rooms/cockpit/ui/screens-work.tsx:239`) |
| `ckWorkerRunning` | `packages/i18n/src/i18n-cockpit.ts:122`, `packages/i18n/src/i18n-cockpit.ts:331` | The day screen displays a worker's running count and task names while that worker has running work (`src/rooms/cockpit/ui/screens-day.tsx:193`) |
| `ckMemoryWeak` | `packages/i18n/src/i18n-cockpit.ts:100`, `packages/i18n/src/i18n-cockpit.ts:309` | The cockpit shows this note when memory search returns related records without a confident answer (`src/rooms/cockpit/ui/screens-ops.tsx:75`) |
| `graphTurnsCeil`, `graphMonthCeil`, `graphMonthCeilOf` | `packages/i18n/src/i18n-graph.ts:5-7`, `packages/i18n/src/i18n-graph.ts:65-67` | The work breakdown labels a turn ceiling and monthly spend, with a separate label when a monthly cap is present (`src/rooms/work-graph/ui/work-breakdown.tsx:98-99`) |
| `liveSessionOpen` | `packages/i18n/src/i18n-graph.ts:58`, `packages/i18n/src/i18n-graph.ts:119` | The thread live panel shows an open-session row with the run ID when `live.session` is present, opening the cockpit `tasks` view on click (`src/rooms/runs/ui/thread-live.tsx:85-91`) |
| `nativeInstallFailed` | `packages/i18n/src/i18n.ts:155`, `packages/i18n/src/i18n.ts:1400` | The text of the error thrown when the Lane Pilot install reports a failure that differs from the previous one; `{error}` is filled by the caller (`src/rooms/native-install/native-install-lifecycle.ts:96`) |
| `largeFileRead*` | `packages/i18n/src/i18n.ts:887-893`, `packages/i18n/src/i18n.ts:2132-2138` | The base dictionaries label task preparation as code scouting and supply the English and Russian help text for the separate helper, `read_first` line threshold, model picker, and helper failure behavior. These entries are translated copy; this package does not implement that helper. |
| `cliOnlyTitle`, `cliOnlyHelp`, `settingOpsCliHelp`, `settingOpsPoolHelp` | `packages/i18n/src/i18n-improvement.ts:16-17`, `packages/i18n/src/i18n-improvement.ts:200-201`, `packages/i18n/src/i18n.ts:871-872`, `packages/i18n/src/i18n.ts:2116-2117` | Retired Lane Stack CLI flags are described as not applied with their stored values kept, in a disclosure that keeps the retired rows out of the live ops section (`src/rooms/pages/service-segment.tsx:191`); pool-size settings use the native run-policy help (`src/rooms/ui-shell/ui/setting-copy.ts:115-130`) |
| `modelOverrides*` | `packages/i18n/src/i18n.ts:208-221`, `packages/i18n/src/i18n.ts:1453-1466` | The "Reset everywhere" panel counts and resets places with own models or agents; the help text states that LP bench projects and sandboxes keep theirs (`src/rooms/ui-shell/ui/model-overrides.tsx:64-74`) |
| `composerBoundarySensitive`, `enumOwnerWordsSensitive` | `packages/i18n/src/i18n.ts:55`, `packages/i18n/src/i18n.ts:970`, `packages/i18n/src/i18n.ts:1300`, `packages/i18n/src/i18n.ts:2215` | Composer boundary text and enum label for `owner.words=sensitive` (money, database changes, and production deploys only) |
| `settingPlanReviseBy*`, `settingPlanMaxRounds*`, `settingPlanMinOwnsPaths*`, `enumReviseByPm`, `enumReviseByPlanner`, `fieldUnitPaths` | `packages/i18n/src/i18n.ts:743`, `packages/i18n/src/i18n.ts:812-817`, `packages/i18n/src/i18n.ts:971-972`, `packages/i18n/src/i18n.ts:2001`, `packages/i18n/src/i18n.ts:2057-2062`, `packages/i18n/src/i18n.ts:2216-2217` | Plan critique revision routing (`planner` default vs `pm`), planner revision round limit, and the 8-path owned-files threshold (`0 = off`) (`src/rooms/ui-shell/ui/setting-copy.ts:56-58`) |
| `settingMemoryScope*`, `enumMemoryScope*`, `settingCodexLeanRoles*` | `packages/i18n/src/i18n.ts:775-778`, `packages/i18n/src/i18n.ts:1006-1007`, `packages/i18n/src/i18n.ts:2020-2023`, `packages/i18n/src/i18n.ts:2251-2252` | Settings and enum labels for `memory.scope` (`section` vs `project`) and `codex.lean_roles` |

## Business rules

- Only English and Russian are supported by the `Locale` type (`packages/i18n/src/i18n.ts:2520`).
- The Russianizer hint wins over navigator and document language; the navigator value wins over the document value when present (`packages/i18n/src/i18n.ts:2533-2541`).
- Only an explicit local-storage value of `"off"` disables the Russianizer hint, and the hint is read only when the plugin footer marker exists (`packages/i18n/src/i18n.ts:2550-2562`).
- `detectLocale` checks a valid global override before module-local state and automatic hints (`packages/i18n/src/i18n.ts:2543-2548`).
- `setLocaleOverride` writes or clears both override values so separate plugin bundles observe explicit selections (`packages/i18n/src/i18n.ts:2526-2531`).
- Known unapplied-reason strings are sourced from `UNAPPLIED_REASON`; unsupported input is preserved instead of replaced with a fabricated translation (`packages/i18n/src/i18n.ts:2610-2634`). The reason constants are declared in settings-catalog (`packages/settings-catalog/src/channels.ts:19`).

## Public API

All declarations below are exported from `i18n.ts` and re-exported by the package root (`packages/i18n/src/index.ts:1-2`). Role-name exports re-exported from `role-names.ts` are listed in [Canonical role names](role-names.md#public-api).

| Import | Source | Purpose |
|---|---|---|
| `en`, `ru` | `packages/i18n/src/i18n.ts:2515-2516` | Complete English and Russian dictionaries |
| `I18nKey`, `Locale`, `LocalePreference` | `packages/i18n/src/i18n.ts:2519-2521` | Translation key and locale types |
| `setLocaleOverride(next)` | `packages/i18n/src/i18n.ts:2526-2531` | Set or clear explicit shared locale override |
| `localeFromSources(documentLanguage?, navigatorLanguage?, russianizerHint?)` | `packages/i18n/src/i18n.ts:2533-2541` | Resolve a locale from supplied hints |
| `detectLocale()` | `packages/i18n/src/i18n.ts:2543-2548` | Read override or browser hints |
| `detectLocaleHint()` | `packages/i18n/src/i18n.ts:2550-2562` | Read browser and Russianizer hints |
| `subscribeToLocaleHintChanges(listener)` | `packages/i18n/src/i18n.ts:2564-2584` | Listen for automatic hint changes; returns cleanup function |
| `t(key)` | `packages/i18n/src/i18n.ts:2586-2588` | Return translated string for a typed key |
| `validationMessage(code, params)` | `packages/i18n/src/i18n.ts:2590-2603` | Translate supported validation errors |
| `stateLabel(state)` | `packages/i18n/src/i18n.ts:2605-2608` | Translate known state key or preserve input |
| `unappliedReason(reason)` | `packages/i18n/src/i18n.ts:2610-2634` | Translate known setting-application reason or preserve input |
| `currentStrings()` | `packages/i18n/src/i18n.ts:2636-2643` | Return four current activation strings |
| `roleName(id)` | `packages/i18n/src/i18n.ts:2646-2648` | Return canonical role display name in the active locale |

## Package shape

- `src/index.ts` is the sole package entry point, re-exporting `i18n.ts` and `role-names.ts` (`packages/i18n/src/index.ts:1-2`, `packages/i18n/package.json:10-13`).
- `src/i18n.ts` merges the base dictionary, feature catalogs, and locale helpers (`packages/i18n/src/i18n.ts:1-23`, `packages/i18n/src/i18n.ts:2515-2648`).
- `src/role-names.ts` holds the canonical bilingual role-name registry and alias lookup; see [Canonical role names](role-names.md).
- `src/i18n-*.ts` files hold feature-specific English and Russian pairs, with their domains identified in catalog headers (`packages/i18n/src/i18n-workflows.ts:1-2`, `packages/i18n/src/i18n-board.ts:1-2`, `packages/i18n/src/i18n-schedule.ts:1-2`, `packages/i18n/src/i18n-improvement.ts:1-2`, `packages/i18n/src/i18n-role-models.ts:2-5`, `packages/i18n/src/i18n-cockpit.ts:1-2`).

## Internal model

Catalogs are plain objects. `I18nKey` combines the English dictionary keys with `agentLabelEn` keys, and the Russian dictionary is assigned the mapped type `{ [K in keyof typeof en]: string }` (`packages/i18n/src/i18n.ts:2516`, `packages/i18n/src/i18n.ts:2519`). Runtime translation selects `ru[key]` or `en[key]` according to `detectLocale()` (`packages/i18n/src/i18n.ts:2586-2588`). `validationMessage` performs placeholder replacement for validation errors (`packages/i18n/src/i18n.ts:2590-2603`).

## Dependencies

`i18n.ts` imports `UNAPPLIED_REASON` from `@lane-pilot/settings-catalog` (`packages/i18n/src/i18n.ts:2`).

Its other imports are local role-name and catalog modules (`packages/i18n/src/i18n.ts:1`, `packages/i18n/src/i18n.ts:3-23`).

The root plugin app imports the package API (`app.tsx:3`). A room server module also imports the package API (`src/rooms/runs/server/rpc/runs.ts:5`).

## Gotchas

See [Gotchas](../gotchas.md) for key collision behavior, override precedence, and unchanged fallback values, and [Canonical role names](role-names.md#gotchas) for role-name defaults and alias label formatting.

<!-- lane-pilot:backlinks -->
## Referenced by

- [i18n workspace overview](../overview.md)

---
title: Writer harness
type: component
created: 2026-10-19
updated: 2026-10-20
status: active
confidence: medium
tags: [writer, harness, learning]
sources:
  - src/rooms/harness/server/harness.ts
  - src/rooms/harness/server/trial.ts
  - src/rooms/harness/server/store.ts
  - src/rooms/harness/migrations.ts
  - packages/harness-core/src/tree.ts
  - packages/harness-core/src/experience.ts
  - packages/harness-core/src/prompts.ts
  - packages/harness-core/src/trajectory.ts
  - src/rooms/harness/server/evidence.ts
  - src/rooms/harness/server/rpc.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/harness/ui/harness-card.tsx
  - src/rooms/writer/server/spawn.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/harness/server/index.ts
  - src/rooms/harness/index.ts
  - src/rooms/tools/server/cli.ts
---

# Writer harness

TL;DR: The harness adds a validated project/area/writer tree to writer attempts, tests candidate trees against the active tree, and records reflections as lessons.

## Purpose

A harness tree contains the optional writer additions described by `LANE_PILOT_SURFACE`: always-on text, skills, checks, hooks and memory. The empty base tree preserves the writer's existing brief, rules, memory and selected skills; an adopted harness adds files to that context (`packages/harness-core/src/tree.ts:31-43`, `src/rooms/harness/server/store.ts:54-66`).

## How it works

1. Before dispatch, the harness chooses a tree using project, task area and writer key. It prefers a matching writer-specific adopted tree, then an area-wide `*` adopted tree, then creates or uses the empty base (`src/rooms/harness/server/harness.ts:187-208`, `src/rooms/harness/server/store.ts:58-66`).
2. If a trial exists for that key, assigned attempts alternate `new` candidate and `old` active tree. The selected tree id and arm are saved on the attempt (`src/rooms/harness/server/harness.ts:187-201`, `src/rooms/harness/server/store.ts:95-107`).
3. `briefParts` selects always-on text, bullet memory, skill names, check names and the tree for the writer brief. Materialization is a separate step: it writes skill and check files under `.lane-pilot/harness` only when the workspace is not live and the Git-exclude command succeeds; it links skills into OpenCode and Claude Code, makes checks executable, and writes Claude Code hooks only for the Claude Code provider (`src/rooms/harness/server/harness.ts:75-78`, `:211-236`).
4. The nightly job finds project areas and writer keys with enough completed attempts, evaluates open trials, then starts editors for eligible keys (`src/rooms/harness/server/harness.ts:539-549`). The evidence includes briefs, trajectories, outcomes, the current harness and library; editor prompts direct editors to trace changes to trajectory evidence and verify repository facts at the current checkout (`src/rooms/harness/server/evidence.ts:36-57`, `packages/harness-core/src/prompts.ts:42-52`, `:110-124`, `:210-220`). Two editors propose invariant and domain changes, then a composer merges candidates into one validated tree (`src/rooms/harness/server/harness.ts:417-445`, `packages/harness-core/src/prompts.ts:127-169`).
5. A valid candidate enters trial. Evaluation compares finished attempts in both arms using acceptance rate, blocking critique findings per attempt, and retries per task; a decided trial adopts or retires the candidate and starts reflection (`src/rooms/harness/server/trial.ts:28-60`, `src/rooms/harness/server/harness.ts:465-485`).
6. Reflection records per-edit verdicts and at most one supported lesson. When supported, the lesson becomes a writer-audience rule proposal with an inferred form; experience fields and rendered Markdown are stored for the harness library (`src/rooms/harness/server/harness.ts:490-524`, `packages/harness-core/src/experience.ts:9-17`, `:67-85`).

## Modes and outcomes

| Mode or state | Inputs and result | Failure or transition |
|---|---|---|
| Disabled | When saved project config has `enabled: false`, `forAttempt` returns `null` and nightly tick returns after trial evaluation without starting editors (`src/rooms/harness/server/harness.ts:187-190`, `:541-545`). | The config reader merges stored values over defaults; disabling does not delete tree rows (`src/rooms/harness/server/harness.ts:165-179`). |
| Base or adopted | Uses the writer-specific tree, then an area-wide adopted tree, then the empty base (`src/rooms/harness/server/harness.ts:204-208`). | A failed file materialization returns a reason; the harness reports no files as written (`src/rooms/harness/server/harness.ts:211-236`). |
| Trial | Alternates candidate and active tree on attempts; records `new` or `old` arm (`src/rooms/harness/server/harness.ts:193-201`). | At the default thresholds, evaluation waits for six finished attempts per arm; after 14 days it can decide with three per arm or retire as unused (`src/rooms/harness/server/trial.ts:18`, `:42-50`). |
| Adopt | At the default slack, requires acceptance no worse by more than five percentage points, no increase in blocking findings or retries, and improvement in at least one measured outcome (`src/rooms/harness/server/trial.ts:18`, `:52-60`). | The prior adopted tree is retired and the candidate becomes adopted (`src/rooms/harness/server/harness.ts:475-485`). |
| Retire | Candidate is not adopted when it is worse or has no measured gain; the old tree stays active (`src/rooms/harness/server/trial.ts:58-60`). | Reflection still records the comparison after a trial decision (`src/rooms/harness/server/harness.ts:490-524`). |
| Editor session | Four roles (`inv`, `dom`, `compose`, `reflect`) use their own complete provider/model selection when set, otherwise the configured editor selection (`src/rooms/harness/server/harness.ts:43-50`, `:356-371`). | A session that ends early gets one restart in the same folder; a rejected tree gets one corrected retry, then the stage keeps its fallback tree and returns the error (`src/rooms/harness/server/harness.ts:120-158`). |

## Business rules

- Harness scope is `(project, area, writer key)`; a writer key is `provider/model`, while `*` applies to any writer in the area (`src/rooms/harness/server/store.ts:20-25`, `src/rooms/harness/server/harness.ts:195-217`).
- The defaults are enabled, five attempts over seven days to qualify a key, at most two keys per nightly run, eight evidence attempts, a 40-minute session wait, and an OpenCode Gemini 3.8 Flash editor selection; project KV settings override them. Role-specific selections inherit the editor unless configured (`src/rooms/harness/server/harness.ts:27-58`, `:165-179`).
- Harness checks are appended to verification for the attempt that owns the tree; a tree with no checks contributes none (`src/rooms/harness/server/harness.ts:239-250`).
- A reflection lesson is stored only when it has cue, lesson and evidence, and its edit rows do not consist solely of `confounded` verdicts (`packages/harness-core/src/experience.ts:37-54`, `src/rooms/harness/server/harness.ts:517-524`).

## Public API or commands

The harness room exports `createHarness`, `harnessRpc`, tree helpers and trial helpers to other rooms (`src/rooms/harness/server/index.ts:1-7`, `src/rooms/harness/index.ts:1`). `judgeSharedTrial` is `decideTrial` (`src/rooms/harness/server/index.ts:6`): the critics writer calls it from lp.critic-edit, so a critic candidate uses the same 14-day deadline and the same bench gate. App RPC methods are `harness_status`, `harness_configure`, `harness_edit`, `harness_tick` and `harness_reflect` (`src/rooms/contracts/rpc-ops.ts:110-129`, `src/rooms/harness/server/rpc.ts:7-17`). The `harness`, `harness-edit`, `harness-tick` and `harness-trajectory` CLI commands expose status, editing, trial evaluation and trajectory output (`src/rooms/tools/server/cli.ts:67-70`, `:170-186`).

### `HarnessCard`

1. On mount or project change, the card clears prior status and loads `harness_status`; a `harness` realtime signal reloads it. A read failure is kept in the card's error state (`src/rooms/harness/ui/harness-card.tsx:48-62`).
2. Edit, judge, configure and model-save actions set a busy key, clear the prior note, call their RPC, reload status on success and clear busy in `finally`. A rejected action stores the message and shows an error toast (`src/rooms/harness/ui/harness-card.tsx:64-89`).
3. Editor selection calls `harness_edit` with `wait:false`; judging calls `harness_tick` with `dryRun:false`; the switch patches `enabled`. Results become a short note before the card reloads (`src/rooms/harness/ui/harness-card.tsx:70-83`).
4. The default editor and each role can select a model when a host and provider list are available. Without either, the card displays model text; if the picker throws during rendering, its error boundary falls back to the same text. A normalized picker value is saved only when provider, model or reasoning level differs (`src/rooms/harness/ui/harness-card.tsx:90-107`).

| UI branch | Behavior and outcome |
|---|---|
| No host or no providers | Displays the configured model and reasoning level as text; no picker is mounted (`src/rooms/harness/ui/harness-card.tsx:90-93`). |
| Picker render failure | `PickerBoundary` renders its text fallback (`src/rooms/harness/ui/harness-card.tsx:21-27`, `:94-105`). |
| Role override exists | Shows a reset button; saving `null` removes that role override and returns it to the editor selection (`src/rooms/harness/ui/harness-card.tsx:85-89`, `:157-176`). |
| RPC action rejects | Shows the error in the card and toast; the action's busy key is cleared (`src/rooms/harness/ui/harness-card.tsx:64-68`). |

## Gotchas

- Live-folder attempts do not materialize skills, checks or hooks; non-Git workspaces, exclude setup failures and file-write failures return a materialization reason (`src/rooms/harness/server/harness.ts:211-225`).
- Only Claude Code receives the harness hooks configuration; other writer runtimes ignore `hooks.json` (`src/rooms/harness/server/harness.ts:231-236`).
- Editor evidence collection reads writer thread events in pages and renders task slices; an event read failure logs and returns the events gathered so far (`src/rooms/harness/server/harness.ts:252-271`, `packages/harness-core/src/trajectory.ts:1-20`).
- Harness tree and experience persistence, including attempt tree/arm fields, is described in the [orchestration data model](data-model/orchestration.md); the pure package API is listed in [shared packages](packages.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
- [Shared packages](packages.md)

---
title: Writer harness
type: component
created: 2026-10-19
updated: 2026-10-19
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

1. Before dispatch, the harness chooses a tree using project, task area and writer key. It prefers a matching writer-specific adopted tree, then an area-wide `*` adopted tree, then creates or uses the empty base (`src/rooms/harness/server/harness.ts:108-134`, `src/rooms/harness/server/store.ts:58-66`).
2. If a trial exists for that key, assigned attempts alternate `new` candidate and `old` active tree. The selected tree id and arm are saved on the attempt (`src/rooms/harness/server/harness.ts:112-127`, `src/rooms/harness/server/store.ts:95-107`).
3. The writer receives always-on text and memory in its brief. Skills and checks are written under `.lane-pilot/harness` in a non-live Git worktree; skills are linked into OpenCode and Claude Code skill directories, checks are made executable, and Claude Code receives hooks through `.claude/settings.local.json` (`src/rooms/harness/server/harness.ts:61-70`, `:136-161`).
4. The nightly job finds project areas and writer keys with enough completed attempts, evaluates open trials, then starts editors for eligible keys (`src/rooms/harness/server/harness.ts:462-492`, `:509-516`). Editors receive recent attempt briefs, trajectories and outcomes; two editors propose invariant and domain changes, then a composer merges their candidates into one validated tree (`src/rooms/harness/server/evidence.ts:36-90`, `src/rooms/harness/server/harness.ts:335-390`).
5. A valid candidate enters trial. Evaluation compares finished attempts in both arms using acceptance rate, blocking critique findings per attempt, and retries per task; a decided trial adopts or retires the candidate and starts reflection (`src/rooms/harness/server/trial.ts:28-60`, `src/rooms/harness/server/harness.ts:400-420`).
6. Reflection records per-edit verdicts and at most one supported lesson. When supported, the lesson becomes a writer-audience rule proposal with an inferred form; experience fields and rendered Markdown are stored for the harness library (`src/rooms/harness/server/harness.ts:425-459`, `packages/harness-core/src/experience.ts:9-17`, `:67-85`).

## Modes and outcomes

| Mode or state | Inputs and result | Failure or transition |
|---|---|---|
| Disabled | Project config `enabled: false`; attempts get no harness tree and nightly tick does not start editors (`src/rooms/harness/server/harness.ts:41-47`, `:112-115`, `:475-480`). | Existing trees remain stored; config is held in BB KV (`src/rooms/harness/server/harness.ts:49-50`, `:97-105`). |
| Base or adopted | Uses the writer-specific tree, then an area-wide adopted tree, then the empty base (`src/rooms/harness/server/harness.ts:129-133`). | A failed file materialization returns a reason; the harness reports no files as written (`src/rooms/harness/server/harness.ts:136-161`). |
| Trial | Alternates candidate and active tree on attempts; records `new` or `old` arm (`src/rooms/harness/server/harness.ts:118-127`). | At the default thresholds, evaluation waits for six finished attempts per arm; after 14 days it can decide with three per arm or retire as unused (`src/rooms/harness/server/trial.ts:18`, `:42-50`). |
| Adopt | At the default slack, requires acceptance no worse by more than five percentage points, no increase in blocking findings or retries, and improvement in at least one measured outcome (`src/rooms/harness/server/trial.ts:18`, `:52-60`). | The prior adopted tree is retired and the candidate becomes adopted (`src/rooms/harness/server/harness.ts:410-414`). |
| Retire | Candidate is not adopted when it is worse or has no measured gain; the old tree stays active (`src/rooms/harness/server/trial.ts:58-60`). | Reflection still records the comparison after a trial decision (`src/rooms/harness/server/harness.ts:425-459`). |

## Business rules

- Harness scope is `(project, area, writer key)`; a writer key is `provider/model`, while `*` applies to any writer in the area (`src/rooms/harness/server/store.ts:20-25`, `src/rooms/harness/server/harness.ts:112-131`).
- The default editor settings are enabled, five attempts over seven days to qualify a key, at most two keys per nightly run, eight evidence attempts, and a 40-minute session wait; project KV settings override these defaults (`src/rooms/harness/server/harness.ts:27-50`, `:97-105`).
- Harness checks are appended to verification for the attempt that owns the tree; a tree with no checks contributes none (`src/rooms/harness/server/harness.ts:164-174`).
- A reflection lesson is stored only when it has cue, lesson and evidence, and its edit rows do not consist solely of `confounded` verdicts (`packages/harness-core/src/experience.ts:37-54`, `src/rooms/harness/server/harness.ts:448-457`).

## Public API or commands

The harness room exports `createHarness`, `harnessRpc`, tree helpers and trial helpers to other rooms (`src/rooms/harness/server/index.ts:1-7`, `src/rooms/harness/index.ts:1`). App RPC methods are `harness_status`, `harness_configure`, `harness_edit`, `harness_tick` and `harness_reflect` (`src/rooms/contracts/rpc-ops.ts:110-129`, `src/rooms/harness/server/rpc.ts:7-17`). The Harness card displays active trees, trials and recent retired trees; it lets the owner toggle editing, start an editor and judge trials (`src/rooms/harness/ui/harness-card.tsx:25-60`). The `harness`, `harness-edit`, `harness-tick` and `harness-trajectory` CLI commands expose status, editing, trial evaluation and trajectory output (`src/rooms/tools/server/cli.ts:60-63`, `:163-179`).

## Gotchas

- Live-folder attempts do not materialize skills, checks or hooks; non-Git workspaces, exclude setup failures and file-write failures return a materialization reason (`src/rooms/harness/server/harness.ts:136-151`).
- Only Claude Code receives the harness hooks configuration; other writer runtimes ignore `hooks.json` (`src/rooms/harness/server/harness.ts:156-160`).
- Editor evidence collection reads writer thread events in pages and renders task slices; an event read failure logs and returns the events gathered so far (`src/rooms/harness/server/harness.ts:188-220`, `packages/harness-core/src/trajectory.ts:1-20`).
- Harness tree and experience persistence, including attempt tree/arm fields, is described in the [orchestration data model](data-model/orchestration.md); the pure package API is listed in [shared packages](packages.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
- [Shared packages](packages.md)

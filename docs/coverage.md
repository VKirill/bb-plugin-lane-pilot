---
title: Coverage registry, graph and drill
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [sma, drill, tests, registry]
sources:
  - src/rooms/coverage/registry.ts
  - src/rooms/coverage/model.ts
  - src/rooms/coverage/cli.ts
  - scripts/lp-drill.py
  - tests/coverage.test.ts
  - tests/fixtures/drill-seen-2026-10-22.json
---

# Coverage registry: graph and drill

TL;DR: `src/rooms/coverage/registry.ts` says, for every pipeline stage, attempt transition, failure class, gate, memory path, room and key mechanism, which deploy-drill scenario runs it on the hub, or which tests exercise it and why no drill does, or why it is not covered at all. A test fails when a node has no entry. `bb lane-pilot coverage` prints the table.

## Purpose

SMA D1-5 («Not covered, with reason», «Graph regression catalogue»). The registries `STAGE_PROOF`, `TRANSITION_TABLE` and `MEMORY_PATHS` say what the code checks; nothing said what the drill (`scripts/lp-drill.py`) actually runs, so a stage could ship that no live run ever touched. Here the answer is written down and tested.

## The nodes and where they come from

| Kind | Listed by | Checked by |
|---|---|---|
| stage | `STAGE_IDS` (`packages/contracts`) | `tests/coverage.test.ts` |
| transition | `TRANSITION_TABLE` (`src/rooms/runs/state-machine.ts`), id `from+event` (`∅` for a new attempt) | the same |
| gate | `GATE_CATEGORIES` (`src/rooms/storage/database.ts`) | the same |
| memory path | `MEMORY_PATHS`, derived: a probed path is live through `memory_paths`, an exempt one is «not covered» with its own reason | `tests/memory-paths.test.ts` |
| failure class | the `FailureClass` type (`src/rooms/runs/failure-class.ts`), read by the test | the test |
| room | the directories of `src/rooms` | the test |
| mechanism | written by hand in the registry (rollback, deferral register, bench, policy, plan-fact, merge queue, …); the spec's mechanisms are required by name | the test |

## Entry rules

An entry names its nodes (`ids`) and either `live` (drill scenarios from `ALL` in `scripts/lp-drill.py`) with `via` (how the drill exercises it), or `tests` with a `reason` (why no drill does), or only a `reason`. The test fails when

- a node of the code has no entry, an entry names a node the code no longer lists, or two entries name one node;
- a drill scenario or a test file named in an entry does not exist;
- a node that is not live has no reason (30 characters at least);
- a tests-only entry cites tests none of which mention its node (the stage id, the gate, the class, `rooms/<room>`).

## The table

`bb lane-pilot coverage [--kind K] [--status live|tests|none] [--json]` prints the counts per kind and one line per node: `live` with the scenario, `tests` with the test files and «not live: reason», `NONE` with «not covered: reason». The counts at the time of writing are in the CHANGELOG.

## Checking the claims against a drill

A «live» claim is a statement about the drill, so the drill proves it. `scripts/lp-drill.py` now writes `seen` into its receipt (`evidence_seen`): the stage receipts, the gate evaluations and the attempt moves its run left on the hub. `bb lane-pilot coverage --receipt <receipt.json|latest>` takes every live claim about a stage, a gate or a transition whose scenario ran in that drill and lists the ones the run left no trace of. A receipt from before `seen` says so and checks nothing. `tests/fixtures/drill-seen-2026-10-22.json` is the quick drill of 2026-10-22 as the hub recorded it; `tests/coverage.test.ts` checks the registry against it. Claims by scenarios outside `--quick` (provider_limit, conflict, main_moved, reload, nogit) are checked the first time a full drill records `seen`.

## What it found

- The drill's tasks carry `verification: []`, so the `verification` stage and gate pass or skip with no command to run: the stage that proves a task's checks is covered by tests only. A drill task with one real check would make it live.
- `pm-read`, `plan-critique` and `specialist-review` are off in the sandbox project and record «skipped» in every drill run; `code-critique` is off by default.
- The failures of a running writer (provider error, timeout, no output, a red check) and the retries after them are not provoked by any scenario; `provider_limit` ends in the `provider` class (a missing model), not in `limit`.
- `project-life` runs in every drill and often fails (60 of 96 receipts of drill tasks on the hub); it never blocks the task, so the drill shows that it starts, not that it passes.

## Adding a node

Add the stage, transition, gate or room and the test fails with the line to add. Pick `live` only if a drill scenario runs it by design, and say how; otherwise cite a test and say why no scenario does. A reason that only says «not tested» is not a reason.

---
title: Run-goal check
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, run, integration, regression]
sources:
  - src/rooms/run-goal/logic.ts
  - src/rooms/run-goal/server/run-goal.ts
  - src/rooms/baseline/server/regress.ts
---

# Run-goal check (SMA D2-3)

Each task of a run is accepted on its own checks. Two tasks green alone can still break each other on the same main. Every 20 minutes
a sweep finds the runs of the last week that are done — every task accepted or canceled, two accepted at least — and have no verdict, and
checks each once: the regression pass (`src/rooms/baseline/server/regress.ts`, option `runId`, mode `full`) runs every accepted task's checks of the run
together in one throwaway worktree of the project's current main, and bisects a red one to the commit that broke it. The nightly regression stays mode `cheap` and is not this verdict.

- `passed`: every required check ran and was green. `partial`: some ran and some were skipped. `inconclusive`: required checks were skipped and none ran. `failed`: a red check that counts, with the culprit commit and task, and one message to the PM. `skipped`: the pass itself did not run (no git, no checks), with the reason. Counts `planned` / `ran` / `skipped_checks` are on the row. One row per run in `lane_pilot_run_goal`.
- `bb lane-pilot run-goal <run-id> | --sweep | --status <run-id>`, RPC `run_goal_status`, `run_goal_check`.
- A red check also stays a regression finding of the baseline room, so the morning list counts it like any other.

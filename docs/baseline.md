---
title: The baseline before a writer
type: component
created: 2026-10-22
updated: 2026-11-26
status: active
confidence: medium
tags: [baseline, sma, acceptance]
sources:
  - src/rooms/baseline/migrations.ts
  - src/rooms/baseline/models/logic.ts
  - src/rooms/baseline/server/repositories/baseline-repository.ts
  - src/rooms/baseline/server/services/baseline-service.ts
  - src/rooms/baseline/server/handlers/baseline-cli.ts
  - src/rooms/writer/server/services/start.ts
  - src/rooms/writer/server/services/finish.ts
  - src/rooms/runs/server/services/acceptance-card.ts
  - tests/baseline/baseline.test.ts
  - tests/baseline/start.test.ts
  - tests/contract-lint-empty-check.test.ts
  - tests/baseline/logic.test.ts
---

# The baseline before a writer

TL;DR: before a task's first writer starts, its `verification[]` runs once on the base commit in a throwaway worktree, so the PM knows which checks were already green («already built?») and which were red; after merge, checks that were green on the base and are red on main are recorded (`turnedRed`). Nothing here reverts or merges anything. (Nightly regression bisect and `regress` were removed.)

## How it works

1. Before the first writer, preflight reads baseline settings, checks for overdue deferrals (`overdueDeferrals`), skips inapplicable attempts, and reserves the project's baseline slot (`src/rooms/writer/server/services/start.ts`, `src/rooms/baseline/server/services/baseline-service.ts`).
2. It builds a throwaway worktree at the task's base, runs uncached eligible checks, then stores outcomes and verdict (`src/rooms/baseline/server/services/baseline-service.ts`, `src/rooms/baseline/server/repositories/baseline-repository.ts`).
3. After merge, the finish path sends verification results to `afterMerge`, which records checks that turned red on main (`src/rooms/writer/server/services/finish.ts`).
4. `baseline_status` RPC and `bb lane-pilot baseline <task-id>` expose stored baseline records (`src/rooms/baseline/server/handlers/baseline-cli.ts`).

| Mode or state | Branch and failure handling |
|---|---|
| Overdue deferral | Preflight stops before writer start with `overdue_deferral` (`src/rooms/baseline/server/services/baseline-service.ts:81-89`). |
| `baseline.already_built=notify` | Reports that every check already passes and continues to the writer; this is the default (`src/rooms/baseline/models/logic.ts`). |
| `baseline.already_built=stop` | Blocks the attempt and returns the base evidence to the PM (`src/rooms/baseline/models/logic.ts`). |
| Red-on-base gate (`checks.require_red_on_base`) | For configured risk levels (`off \| medium \| high`, default `medium`), all checks passing on base closes `fix`/`check` as `already done:` or blocks other kinds (`no_red_on_base`). |
| Worktree, host, or check trouble | Records an unknown result and allows writer start to continue (`src/rooms/baseline/server/services/baseline-service.ts`). |

## Bounds, caching, and acceptance projection

- **Where it runs.** A throwaway worktree of the base checkout's HEAD (`rollback.kit.makeWorktree`), checks run through `services.runVerification`. One baseline at a time per project (`baseline:<project>`).
- **What is bounded.** `baseline.time_cap_sec` (default 300, 0 turns baseline off) caps estimated check duration sum using `lane_pilot_check_duration` p95 history.
- **Caching.** Results for `(baseSha, command)` are cached (`cachedChecks`) across retries and sibling tasks.
- **Acceptance card.** `buildAcceptanceCard` (`src/rooms/runs/server/services/acceptance-card.ts`) projects the baseline record (`verdict`, `action`, `mode`, `checks`, `turnedRed`) onto `task_acceptance_card`.
- **What turned red.** After merge, checks green on base and red on main populate `turnedRed`.

## Tables & CLI

Appended to `migrations`: `lane_pilot_baseline`. CLI: `bb lane-pilot baseline <task-id>` (`src/rooms/baseline/server/handlers/baseline-cli.ts`), RPC: `baseline_status`.

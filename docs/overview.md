---
title: Lane Pilot overview
type: overview
created: 2026-10-10
updated: 2026-11-27
status: active
confidence: high
tags: [overview, bb-plugin, orchestration]
sources:
  - package.json
  - server.ts
  - app.tsx
  - src/rooms/registry.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/native-agent/ui/composer-enable.tsx
  - src/rooms/writer/server/services/dispatch.ts
  - src/rooms/writer/server/services/start.ts
  - src/rooms/writer/server/services/verify.ts
  - src/rooms/writer/server/services/finish.ts
  - src/rooms/writer/server/services/skill-pick.ts
  - src/rooms/stability/server/services/reconcile.ts
  - src/rooms/pages/ui/page.tsx
  - src/rooms/pages/ui/console-shell.tsx
  - src/rooms/pages/ui/console-routes.tsx
  - src/rooms/pages/models/nav-model.ts
  - src/rooms/critique/server/services/pm-read.ts
  - src/rooms/critique/models/pm-read.ts
  - src/rooms/critique/models/citations.ts
  - src/rooms/storage/database.ts
  - src/rooms/migrations.ts
  - src/rooms/schedule/server/handlers/board-clock.ts
  - src/rooms/memory/server/services/memory.ts
  - src/rooms/runs/server/services/task-board.ts
  - src/rooms/runs/server/services/task-graph.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/ui/task-board.tsx
  - src/rooms/evolve/index.ts
  - packages/contracts/src/stage-proof.ts
  - packages/workflow-engine/src/inbox.ts
  - packages/workflow-engine/src/engine-clock.ts
  - workflows/lp-task-pipeline.json
  - src/rooms/tasks/models/contract-lint.ts
  - src/rooms/usage/server/services/attempt-metrics.ts
  - src/rooms/tools/server/handlers/cli-project.ts
  - src/rooms/contracts/quality-mode.ts
---

# Lane Pilot overview

TL;DR: Lane Pilot is a BB plugin that turns a project chat into an orchestration surface for isolated coding tasks, checks, reviews, scheduled graphs, and project memory.

## Product shape

The plugin is registered by BB from the `bb.server` entry in `package.json`; the entry opens plugin storage, builds a shared server core, composes room services from `src/rooms/registry.ts`, and registers RPC, tools, CLI verbs, and the single engine clock (`package.json:16-18`, `server.ts:104-376`). The plugin UI is a separate `bb.app` entry (`package.json:16-18`, `app.tsx`), and host machine work runs through `host.ts`.

Every piece of work Lane Pilot runs is a graph (`workflows/*.json`, categorized via `GRAPH_CATEGORIES` in `packages/contracts/src/graph-categories.ts`): writer tasks (`lp-task-pipeline`, which also runs browser checks when a task has `qa_cases` and `qa_url`), errands, specialists, browser steps, scheduled routines, and the post-acceptance memory pass (`lp.after-accept`). Graphs are driven by events (`lane_pilot_wf_inbox`), durable waits with absolute deadlines, and the single engine clock (`engine-clock`); the PM chat is the door to the machine, not its engine.

A user enables Lane Pilot for a project chat through the composer. The UI gets activation context, requires a selected project and a resolvable writer binding, then sets a dispatch token and native agent selection (`src/rooms/native-agent/ui/composer-enable.tsx`).

The PM sends work through Lane Pilot tools. The writer dispatcher resolves task ownership and starts writer attempts (`lp-task-pipeline`); attempts use an isolated workspace, then verification and finish stages produce receipts and merge accepted work (`src/rooms/writer/server/services/dispatch.ts`, `start.ts`, `verify.ts`, `finish.ts`). Before a writer starts, the skill picker combines project-folder skills, `modern-web-guidance` when `taskTouchesWeb` matches web file paths, the browser skill when a task checks a page, and catalogued PM hints (`src/rooms/writer/server/services/skill-pick.ts`). When PM read is enabled, `runPmRead` checks the `read_first` excerpts to count lines and asks a helper to read the code and return a JSON summary, key facts, and open questions (`src/rooms/critique/server/services/pm-read.ts`, `src/rooms/critique/models/pm-read.ts`). The minimum line setting defaults to 350 (50 to 5,000), provider/model settings fall back to the writer selection, existing `pm-read` receipts are reused without another helper call, and provider/model/spawn errors are recorded as failed (`src/rooms/critique/server/services/pm-read.ts`).

## Main areas

The plugin page (`LanePilotPage` + `ConsoleShell` in `src/rooms/pages/ui/page.tsx`, `console-shell.tsx`, `console-routes.tsx`) exposes six owner-console sections (`overview`, `decisions`, `staff`, `work`, `memory`, `system`), six sub-pages under **System** (`graphs`, `agents`, `schedules`, `costs`, `health`, `settings`; `src/rooms/pages/models/nav-model.ts`), a top scope switcher (`ScopeSwitcher` for all projects, a project, or a section), and a global `BrakeButton` (`BrakesDialog`). Legacy routes (`LEGACY_TABS`, `LEGACY_SCOPES`) resolve to the corresponding sections.

When reload recovery (`taskReconcile.reconcile`) finds the writer's prior thread idle or errored, the attempt loop resumes in that thread if its persisted run and contract context are valid; a canceled attempt is closed as canceled (`src/rooms/stability/server/services/reconcile.ts`). Eligible new attempts and fallbacks receive the prior task-owned validation failure; provider failures do not replace that context (`src/rooms/writer/server/services/start.ts`).

- **Project orchestration:** runs, tasks, attempts, stage receipts, checks, workflow inbox events, and merge coordination are stored in plugin SQLite (`src/rooms/migrations.ts`, `src/rooms/storage/database.ts`). See [architecture](architecture.md) and [data model](data-model.md).
- **Work and tasks:** **Work → Tasks** (`WorkScreen` + `TaskBoard` in `src/rooms/runs/ui/work-screen.tsx`, `task-board.tsx`) shows task attempts and top-level workflow runs in a board or grouped list alongside **Big projects** and **Errands**, with `TaskPage` for contract, stage, attempt, and worker-thread detail (`src/rooms/runs/server/services/task-board.ts`). See [Tasks board](task-board.md).
- **Settings and integrations:** typed settings live in `src/rooms/settings-registry.ts` (including **model per function** with automatic fallback) and typed RPC endpoints expose settings, workflows, schedules, memory, and runs to the UI (`src/rooms/core/server/rpc.ts`). The surface is declared in [RPC contracts](rpc-callers.md).
- **Schedule board and engine clock:** one clock (`packages/workflow-engine/src/engine-clock.ts`, `src/rooms/schedule/server/handlers/board-clock.ts`) wakes overdue waiting steps and due schedule-board rows (owner rows plus `SYSTEM_SCHEDULES` and `PROJECT_SCHEDULES`), respecting the board-wide pause (`schedule.paused_all`).
- **Project knowledge:** memory RPCs create and retrieve project-scoped agent records; the UI displays records and lifecycle (`src/rooms/memory/server/services/memory.ts`, `src/rooms/memory/ui/memory-screen.tsx`).
- **Evolution building blocks:** per-step run facts (`lane_pilot_wf_step`), paired arm comparison and trial gating (`src/rooms/evolve/`), and planted-defect checker gating (`src/rooms/checkers/`) provide the primitives for the proposed `lp.evolve` graph (`docs/decisions/2026-11-25-evolution-graph.md`).

## Stage proof and attempt metrics

Every stage declares what decides that it is done: a code predicate (a command's exit code, a file, a gate or receipt record, a schema validation) or `advisory` with a reason, which marks a model's opinion (`packages/contracts/src/stage-proof.ts:24-49`). The registry covers every stage id, so a new stage does not compile without a proof, and `workflows/lp-task-pipeline.json` carries the same declarations on its nodes. The opinion stages are `pm-read`, `plan-critique`, `specialist-review` and `code-critique`. An opinion never accepts a task; it can still stop one. The plan critic in `plan_critique.mode` `gate` (the default) refuses a plan before any writer starts, and a refusing code critic holds the candidate (it runs whenever `code_critique.enabled`, and by default also for tasks of risk medium or higher through `critic.code.default_for_risk` = `medium`). A failed `pm-read` summary stops nothing: the task goes on without it. Code still checks their form: a blank pm-read summary fails the stage, and a critical or high finding that cites a file the reviewer was never shown, or a line past the end of a file it was shown, is read as medium (`src/rooms/critique/models/pm-read.ts`, `src/rooms/critique/models/citations.ts`).

Acceptance refuses an opinion as its only reason. Before the acceptance receipt is written, the writer finish collects the stages that passed for the candidate, and a set with no code-decided stage blocks the attempt (`src/rooms/writer/server/services/finish-attempt-body.ts`, `packages/contracts/src/stage-proof.ts`).

These are the pipeline's capabilities, not a project's live configuration: every opinion and review stage obeys its `*.enabled` project setting and `quality_mode` (`quick` disables both critiques, `standard` reads the settings, `full` enables them), so a stage with no setting is recorded `skipped` with reason `disabled_by_project_setting` (`src/rooms/contracts/quality-mode.ts:12-30`). The generated [enabled settings](enabled-settings.md) page lists the defaults and the global `*` values.

The contract lint refuses a verification command that cannot fail (`true`, `:`, `exit 0`, a bare `echo`, or a failure hidden by `|| true`), and for risk medium or higher it warns, without refusing, when no check names a file that is missing on the base commit (`src/rooms/tasks/models/contract-lint.ts`).

`bb lane-pilot metrics <project-id> [--days N]` and the `lp_attempt_metrics` RPC list each attempt with its stages passed or failed, seconds per stage, writer tokens and a list-price cost. A provider that reports no usage, such as acp-cursor, shows `not_measured` with no tokens and no cost, never zero; a model with no price or a thread shared by several attempts shows `partial` (`src/rooms/usage/server/services/attempt-metrics.ts`, `src/rooms/tools/server/handlers/cli-project.ts`).

## Workspaces

The root workspace contains BB-facing rooms and 12 shared packages under `packages/*`. `@lane-pilot/ui-kit` and `@lane-pilot/workflow-engine` own their internal documentation ([UI kit overview](../packages/ui-kit/docs/overview.md), [workflow engine overview](../packages/workflow-engine/docs/overview.md)). The remaining packages (`contracts`, `handoff`, `host-calls`, `i18n`, `kit`, `memory-core`, `models`, `resilience`, `settings-catalog`, `thread-observe`) are listed in [packages](packages.md).

## System references

- [Architecture](architecture.md) — runtime composition and dependency boundaries.
- [Conventions](conventions.md) — enforced room layout, engine primitives, and ratchets.
- [Deployment](deployment.md) — build, configuration, run, and deploy inputs.
- [Gotchas](gotchas.md) — cross-cutting behavior and failure boundaries.
- [Data model](data-model.md) — core entity map and domain-owned table references.

---
title: Lane Pilot overview
type: overview
created: 2026-10-10
updated: 2026-10-29
status: active
confidence: low
tags: [overview, bb-plugin, orchestration]
sources:
  - package.json
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/native-agent/ui/composer-enable.tsx
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/stability/server/reconcile.ts
  - src/rooms/cockpit/ui/cockpit-page.tsx
  - src/rooms/cockpit/server.ts
  - src/rooms/cockpit/ui/screens-day.tsx
  - src/rooms/cockpit/ui/screens-ops.tsx
  - src/rooms/cockpit/ui/screens-work.tsx
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/critique/server/critique-runs.ts
  - src/rooms/critique/pm-read.ts
  - packages/jev/src/judgments/skill-pick.ts
  - src/rooms/writer/server/skill-pick.ts
  - src/rooms/storage/database.ts
  - src/rooms/harness/server/harness.ts
  - src/rooms/harness/migrations.ts
  - src/rooms/schedule/scheduler.ts
  - src/rooms/anamnesis/collect.ts
  - src/rooms/council/ui/council-page.tsx
  - src/rooms/council/ui/office-scene.ts
  - src/rooms/memory/server/memory.ts
  - src/rooms/core/server/lifecycle-events.ts
  - src/rooms/anamnesis/pii.ts
  - src/rooms/anamnesis/year-review.ts
  - src/rooms/memory/ui/memory-records.tsx
  - src/rooms/runs/server/task-board.ts
  - src/rooms/runs/server/task-graph.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/ui/task-board.tsx
  - packages/contracts/src/stage-proof.ts
  - workflows/lp-task-pipeline.json
  - src/rooms/critique/citations.ts
  - src/rooms/tasks/server/contract-lint.ts
  - src/rooms/usage/server/attempt-metrics.ts
  - src/rooms/tools/server/cli.ts
---

# Lane Pilot overview

TL;DR: Lane Pilot is a BB plugin that turns a project chat into an orchestration surface for isolated coding tasks, checks, reviews, and project maintenance.

## Product shape

The plugin is registered by BB from the `bb.server` entry in `package.json`; the entry opens plugin storage, builds a shared server core, mounts room services, then registers RPC and tools (`package.json:8-18`, `server.ts:55-107`). The plugin UI is a separate `bb.app` entry (`package.json:8-18`).

Every piece of work Lane Pilot runs is a graph (a workflow, in code and in English): writer tasks (`lp-task-pipeline`, which also runs the browser check of a task that has `qa_cases` and `qa_url`), phases (`lp.*`), errands, specialists, browser steps and browser checks, councils, scheduled agent routines and the after-accept pass. Graphs run without a PM chat; the PM chat is the door (it talks to the owner and passes his words into the machine), not the engine. In Russian UI the word is «граф».

A user enables Lane Pilot for a new project chat through the composer. The UI gets activation context, requires a selected project and a resolvable writer binding, then sets a dispatch token and native agent selection (`src/rooms/native-agent/ui/composer-enable.tsx:49-60`, `:71-94`, `:96-123`).

When enabled, the writer harness assigns an adopted tree or the empty base to an attempt and records the selected tree and trial arm; always-on text and memory enter the writer brief, while skills, checks and hooks are materialized in supported non-live workspaces (`src/rooms/harness/server/harness.ts:183-196`, `:205-236`). Candidate trees are trialed against the active tree, and reflection can submit a supported lesson to the rule pipeline (`src/rooms/harness/server/harness.ts:465-485`, `:490-522`). See the [writer harness](harness.md) for editor evidence, retry behavior, trial rules and controls. The PM sends work through Lane Pilot tools. The writer dispatcher resolves task ownership and starts writer attempts; attempts use an isolated workspace, then verification and finish stages produce receipts and merge accepted work (`src/rooms/writer/server/dispatch.ts:1-82`, `src/rooms/writer/server/start.ts:1-80`, `src/rooms/writer/server/verify.ts:1-80`, `src/rooms/writer/server/finish.ts:1-82`). Before a writer starts, the skill picker combines project-folder skills, task-matched technology skills, craft skills selected for the task's judged output, and catalogued PM hints; Jev errors or a 15-second timeout leave the writer with its role skills (`packages/jev/src/judgments/skill-pick.ts:211-231`, `src/rooms/writer/server/skill-pick.ts:6-15`, `:114-147`). When PM read is enabled, `runPmRead` reads the task's `read_first` excerpts into a bounded execution packet and asks a helper for a JSON summary, key facts, and open questions (`src/rooms/critique/server/critique-runs.ts:62-106`, `src/rooms/critique/pm-read.ts:32-43`). The minimum line setting defaults to 350 and must be an integer from 50 to 5,000; selected excerpts below it skip the helper call, and provider/model settings fall back to the writer selection (`src/rooms/critique/pm-read.ts:13-25`, `src/rooms/critique/server/critique-runs.ts:38-45`, `:68-72`). The result requires `summary`, `keyFacts`, and `openQuestions` within their schema limits, but extra top-level keys are stripped (`src/rooms/critique/pm-read.ts:27-29`, `:42-43`). An existing `pm-read` receipt is returned without another helper call; disabled PM read and excerpts below the line threshold are recorded as skipped, while provider, model, reasoning, output, and spawn errors are recorded as failed (`src/rooms/critique/server/critique-runs.ts:47-60`, `:68-72`, `:75-115`).

## Main areas

The cockpit is the app's screen shell: it loads project and run context, remembers the selected project locally, signals silent-hub and signed-out states, and dispatches the selected screen (`src/rooms/cockpit/ui/cockpit-page.tsx:21-70`). Its RPC handler supplies screen state and event subscription methods (`src/rooms/cockpit/server.ts:17-76`); screen-specific behavior lives in the Today, Forge and Phases views (`src/rooms/cockpit/ui/screens-day.tsx:10-38`, `src/rooms/cockpit/ui/screens-ops.tsx:10-49`, `src/rooms/cockpit/ui/screens-work.tsx:14-35`).

When reload recovery finds the writer's prior thread idle or errored, the attempt loop resumes in that thread if its persisted run and contract context are valid; a canceled attempt is closed as canceled (`src/rooms/stability/server/reconcile.ts:111-145`). Eligible new attempts and fallbacks receive the prior task-owned validation failure; provider failures do not replace that context (`src/rooms/writer/server/start.ts:56-83`, `:669`, `:920`).

- **Project orchestration:** runs, tasks, attempts, stage receipts, checks, and merge coordination are stored in plugin SQLite (`src/rooms/storage/database.ts:30-70`, `:128-156`). See [architecture](architecture.md) and [data model](data-model.md).
- **Tasks screen:** the app shows task attempts and top-level workflow runs in a board or grouped list, with a detail page for contract, stage, attempt, and worker-thread data (`src/rooms/runs/ui/task-board.tsx:121-153`, `src/rooms/runs/server/task-board.ts:63-78`, `:147-209`). See [Tasks board](task-board.md).
- **Settings and integrations:** typed RPC endpoints expose project settings, provider selection, workflows, schedules, council, memory, and knowledge to the UI (`src/rooms/core/server/rpc.ts:27-51`). The surface is declared in [RPC contracts](rpc-callers.md).
- **Project knowledge:** memory RPCs create and retrieve project-scoped agent records; the UI displays the records and their lifecycle (`src/rooms/memory/server/memory.ts:19-78`, `src/rooms/memory/ui/memory-records.tsx:13-64`).
- **Owner profile:** Anamnesis collects enabled sources, masks detected personal data, stores evidence-backed records, and can render an annual review (`src/rooms/anamnesis/collect.ts:29-63`, `src/rooms/anamnesis/pii.ts:41-72`, `src/rooms/anamnesis/year-review.ts:13-72`).
- **Council and world view:** `CouncilPage` renders the council session UI; on desktop its office view builds an isometric cutaway floor with exterior ground, paving, trees and bushes, then floor zones, walls, doors and layout furniture. The Pixel World service is composed into the plugin services (`src/rooms/council/ui/council-page.tsx:64-65`, `src/rooms/council/ui/office-scene.ts:59-69`, `:90-136`, `:166-185`, `:300-303`, `server.ts:112-114`).

## Stage proof and attempt metrics

Every stage declares what decides that it is done: a code predicate (a command's exit code, a file, a gate or receipt record, a schema validation) or `advisory` with a reason, which marks a model's opinion (`packages/contracts/src/stage-proof.ts:24-49`). The registry covers every stage id, so a new stage does not compile without a proof, and `workflows/lp-task-pipeline.json` carries the same declarations on its nodes (`workflows/lp-task-pipeline.json:71`, `:275`). The four opinion stages are `pm-read`, `plan-critique`, `specialist-review` and `code-critique`. An opinion never accepts a task; it can still stop one. The plan critic in `plan_critique.mode` `gate` (the default) refuses a plan before any writer starts, and a refusing code critic holds the candidate. A failed `pm-read` summary stops nothing: the task goes on without it. Code still checks their form: a blank pm-read summary fails the stage, and a critical or high finding that cites a file the reviewer was never shown, or a line past the end of a file it was shown, is read as medium (`src/rooms/critique/pm-read.ts:30`, `src/rooms/critique/citations.ts:20-50`).

Acceptance refuses an opinion as its only reason. Before the acceptance receipt is written, the writer finish collects the stages that passed for the candidate, and a set with no code-decided stage blocks the attempt (`src/rooms/writer/server/finish.ts:628-640`, `packages/contracts/src/stage-proof.ts:55-61`).

The contract lint refuses a verification command that cannot fail (`true`, `:`, `exit 0`, a bare `echo`, or a failure hidden by `|| true`), and for risk medium or higher it warns, without refusing, when no check names a file that is missing on the base commit (`src/rooms/tasks/server/contract-lint.ts:76-96`, `:225-233`).

`bb lane-pilot metrics <project-id> [--days N]` and the `lp_attempt_metrics` RPC list each attempt with its stages passed or failed, seconds per stage, writer tokens and a list-price cost. A provider that reports no usage, such as acp-cursor, shows `not_measured` with no tokens and no cost, never zero; a model with no price or a thread shared by several attempts shows `partial` (`src/rooms/usage/server/attempt-metrics.ts:65-126`, `src/rooms/tools/server/cli.ts:190-197`).

## Workspaces

The root workspace contains BB-facing rooms and small shared packages. `@lane-pilot/ui-kit`, `@lane-pilot/workflow-engine`, and `@lane-pilot/world-sim` own their internal documentation; this page links to their overviews instead of restating internals ([UI kit overview](../packages/ui-kit/docs/overview.md), [workflow engine overview](../packages/workflow-engine/docs/overview.md), [world simulation overview](../packages/world-sim/docs/overview.md)). The remaining small packages are described in [packages](packages.md).

## System references

- [Architecture](architecture.md) — runtime composition and dependency boundaries.
- [Deployment](deployment.md) — build, configuration, run, and deploy inputs.
- [Gotchas](gotchas.md) — cross-cutting behavior and failure boundaries.
- [Data model](data-model.md) — core entity map and domain-owned table references.
- [Jev adapter](jev-adapter.md) — native writer reasoning selection.

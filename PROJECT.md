---
title: Lane Pilot project facts
updated: 2026-11-26
sources:
  - package.json
  - server.ts
  - src/rooms/registry.ts
  - src/rooms/services.ts
  - src/rooms/contracts/room.ts
  - src/rooms/workflow/server/services/workflow-executors.ts
  - src/rooms/workflow/server/services/workflow-triggers.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/rpc-ops.ts
  - scripts/test-changed.mjs
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/services/dispatch.ts
  - src/rooms/writer/server/services/start.ts
  - src/rooms/stability/server/services/reconcile.ts
  - src/rooms/writer/server/services/reopen-attempt.ts
  - src/rooms/relay/server/services/relay.ts
  - src/rooms/verification/sandbox.ts
  - src/rooms/writer/server/services/verify.ts
  - src/rooms/writer/server/services/finish.ts
  - src/rooms/critique/server/services/critique-runs.ts
  - src/rooms/stability/server/services/deploy-drain.ts
  - src/rooms/worktree/merge.ts
  - src/rooms/worktree/worktree-dependencies.ts
  - packages/workflow-engine/src/inbox.ts
  - packages/workflow-engine/src/engine-settle.ts
  - packages/workflow-engine/src/engine-clock.ts
  - packages/kit/src/owns-paths.ts
  - packages/thread-observe/src/completion.ts
  - docs/overview.md
  - docs/task-board.md
  - src/rooms/runs/server/services/task-board.ts
  - src/rooms/runs/server/services/task-graph.ts
  - src/rooms/runs/server/rpc/runs.ts
  - docs/architecture.md
  - docs/conventions.md
  - docs/testing.md
  - docs/gotchas.md
  - docs/deployment.md
  - docs/data-model.md
  - docs/decisions.md
---

# Lane Pilot

## Identity

- BB plugin; server, host worker, and app entries: [`package.json`](package.json), [`docs/overview.md`](docs/overview.md).
- Root package workspaces: `packages/*` (12 workspaces); server areas: `src/rooms/*` ([architecture](docs/architecture.md)).

## Entry points

- Plugin factory: [`server.ts`](server.ts).
- Host worker: [`host.ts`](host.ts).
- BB app: [`app.tsx`](app.tsx).
- Room registry and service bag: [`src/rooms/registry.ts`](src/rooms/registry.ts), [`src/rooms/services.ts`](src/rooms/services.ts), [`src/rooms/contracts/room.ts`](src/rooms/contracts/room.ts).
- Plugin RPC contract: [`src/rooms/core/server/plugin-contracts.ts`](src/rooms/core/server/plugin-contracts.ts), [`src/rooms/contracts/index.ts`](src/rooms/contracts/index.ts).
- Operations RPC routes: [`src/rooms/contracts/rpc-ops.ts`](src/rooms/contracts/rpc-ops.ts), registered by [`src/rooms/core/server/rpc.ts`](src/rooms/core/server/rpc.ts).
- Workspace package contracts: [`docs/packages.md`](docs/packages.md).

## Critical invariants

- Startup opens plugin SQLite before composing room services ([`src/rooms/storage/database.ts`](src/rooms/storage/database.ts), [`server.ts`](server.ts)).
- Room layout (`index.ts`, `models/`, `server/{handlers,services,repositories}/`, `ui/`, with host `fs`/`child_process` files at room level) and room registry completeness are enforced by [`tests/architecture/room-layout.test.ts`](tests/architecture/room-layout.test.ts) and [`tests/architecture/room-registry.test.ts`](tests/architecture/room-registry.test.ts).
- Migrations in [`src/rooms/migrations.ts`](src/rooms/migrations.ts) are positional and append-only; slices of retired rooms remain frozen in [`src/rooms/legacy-migrations.ts`](src/rooms/legacy-migrations.ts) ([`tests/migration-lineage.test.ts`](tests/migration-lineage.test.ts)).
- Workflow events use the append-only `lane_pilot_wf_inbox` table, waiting steps store absolute deadlines with compare-and-set wake and required timeout edges, runs execute against their stored snapshot, and one engine clock drives waiting deadlines and schedule-board rows ([`docs/conventions.md`](docs/conventions.md#engine-primitives-and-invariants)).
- Shared vocabularies have one owning home guarded by [`tests/architecture/one-home.test.ts`](tests/architecture/one-home.test.ts).
- UI RPC schemas and host call schemas are separate ([`docs/rpc-callers.md`](docs/rpc-callers.md)).
- Tasks board state is derived from stored latest task attempts, stage receipts, and top-level workflow runs ([`docs/task-board.md`](docs/task-board.md)).
- Writer workspace branches and no-Git rollback mode are documented in [ADR 1](docs/decisions.md#adr-1-isolate-writer-workspaces) and [gotchas](docs/gotchas.md).
- Moved-main replay checks and path ownership outcomes are documented in [validator decisions](docs/validator-decisions.md).
- Host checkout writes and acceptance checks participate in the reload drain ([deployment](docs/deployment.md#configuration-and-runtime)).
- Verification output capture limits are documented in [cross-cutting gotchas](docs/gotchas.md).
- Workflow tasks dispatched by the chain executor include planner file steps in their canonical plan for plan critique, and preserve persisted plans across reentrant reloads ([`src/rooms/workflow/server/services/workflow-executors.ts`](src/rooms/workflow/server/services/workflow-executors.ts); [`docs/workflow-executors.md`](docs/workflow-executors.md)).
- Workflow engine and UI-kit internals belong to their [workspace docs](docs/overview.md#workspaces).

## Conventions

- Server implementation belongs in a room server module or package; `server.ts` assembles modules and iterates `src/rooms/registry.ts` ([architecture](docs/architecture.md#startup-and-service-composition)).
- Cross-room imports use room public indices; packages do not import `src/` ([architecture](docs/architecture.md#dependency-boundaries-and-room-layout), [conventions](docs/conventions.md)).
- Contracts and methods are documented in [RPC and host-call contracts](docs/rpc-callers.md).
- Tasks board and helper-thread graph behavior is documented in [Tasks board](docs/task-board.md).
- Testing suites, isolation rules, and verification commands are documented in [testing](docs/testing.md).

## Common gotchas

- Thread events wake watchers and feed `lane_pilot_wf_inbox` via `emitEvent` / `engine.wake()`; fresh reads decide completion, with a fallback poll. Error-status decisions retain a detected BB failure cause ([gotchas](docs/gotchas.md#event-and-polling-behavior)).
- An admitted writer task holds overlapping ownership paths through redos and fallbacks until its writer loop ends ([gotchas](docs/gotchas.md#dispatch-and-retries)).
- A reload during dispatch resumes the pipeline for the same attempt with its immutable base retained, through baseline before starting the writer ([gotchas](docs/gotchas.md#dispatch-and-retries)).
- OpenCode v2 is one shared service per host: writer settings travel as the `lane-pilot` agent and a worktree `.opencode/opencode.jsonc`, not as process environment ([gotchas](docs/gotchas.md#stability-and-local-provider-setup)).
- Host-prepared BB guard wrappers differ for new helpers, owner threads, and older hosts ([native agent](docs/native-agent.md#public-api-or-commands)).
- Live-folder mode has explicit caps and rollback limits ([gotchas](docs/gotchas.md#writer-workspace-modes)).
- Verification worktrees copy `node_modules/.bin` and `.package-lock.json` into the worktree so `npm install` writes inside it (`src/rooms/worktree/worktree-dependencies.ts`).
- Verification preparation refreshes missing or stale npm dependencies in the base checkout, then mirrors root, workspace, and supported nested package dependencies into the attempt worktree (`src/rooms/worktree/deps-install.ts`, `src/rooms/worktree/worktree-dependencies.ts`).
- Sandboxed checks can read linked user tool installations and Playwright browser binaries through a temporary HOME (`src/rooms/verification/sandbox.ts`).
- A reload resumes a running attempt in its existing writer thread when that thread is idle or errored and the saved run, task, contract and workspace are usable; a pending cancellation closes as canceled (`src/rooms/stability/server/services/reconcile.ts`).
- Workflow chain tasks append planned file steps (`task.files[]`) to `task.objective` in their canonical plan, while reentrant dispatches retain stored plan text from SQLite (`src/rooms/workflow/server/services/workflow-executors.ts`; [workflow executors](docs/workflow-executors.md)).

## Useful commands

- `npm test`
- Focused test selection → [build and deployment](docs/deployment.md#configuration-and-runtime)
- `npm run typecheck`
- `npm run build`
- `npm run test:layout`
- `npm run check`

See [deployment](docs/deployment.md#build) for command ownership and manifest inputs.

## Where to look next

- [System overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [Conventions](docs/conventions.md)
- [Testing](docs/testing.md)
- [Deployment](docs/deployment.md)
- [Data model](docs/data-model.md)
- [Shared packages](docs/packages.md)
- [Tasks board](docs/task-board.md)
- [Decisions](docs/decisions.md)

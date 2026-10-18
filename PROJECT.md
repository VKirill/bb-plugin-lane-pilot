---
title: Lane Pilot project facts
updated: 2026-10-18
sources:
  - package.json
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/rpc-ops.ts
  - scripts/test-changed.mjs
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/reopen-attempt.ts
  - src/rooms/self-repair/server/self-repair.ts
  - src/rooms/relay/server/relay.ts
  - src/rooms/verification/sandbox.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/critique/server/critique-runs.ts
  - src/rooms/stability/server/deploy-drain.ts
  - src/rooms/verification/git-integrate.ts
  - packages/kit/src/owns-paths.ts
  - packages/thread-observe/src/completion.ts
  - docs/overview.md
  - docs/task-board.md
  - src/rooms/runs/server/task-board.ts
  - src/rooms/runs/server/task-graph.ts
  - src/rooms/runs/server/rpc/runs.ts
  - docs/architecture.md
  - docs/gotchas.md
  - docs/deployment.md
  - docs/data-model.md
  - docs/decisions.md
---

# Lane Pilot

## Identity

- BB plugin; server, host worker, and app entries: [`package.json`](package.json), [`docs/overview.md`](docs/overview.md).
- Root package workspaces: `packages/*`; server areas: `src/rooms/*` ([architecture](docs/architecture.md)).

## Entry points

- Plugin factory: [`server.ts`](server.ts).
- Host worker: [`host.ts`](host.ts).
- BB app: [`app.tsx`](app.tsx).
- Plugin RPC contract: [`src/rooms/contracts/index.ts`](src/rooms/contracts/index.ts).
- Operations RPC routes: [`src/rooms/contracts/rpc-ops.ts`](src/rooms/contracts/rpc-ops.ts), registered by [`src/rooms/core/server/rpc.ts`](src/rooms/core/server/rpc.ts).
- Workspace package contracts: [`docs/packages.md`](docs/packages.md).

## Critical invariants

- Startup opens plugin SQLite before composing room services ([`src/rooms/storage/database.ts`](src/rooms/storage/database.ts), [`server.ts`](server.ts)).
- UI RPC schemas and host call schemas are separate ([`docs/rpc-callers.md`](docs/rpc-callers.md)).
- Tasks board state is derived from stored latest task attempts, stage receipts, and top-level workflow runs ([`docs/task-board.md`](docs/task-board.md)).
- Writer workspace branches and no-Git rollback mode are documented in [ADR 1](docs/decisions.md#adr-1-isolate-writer-workspaces) and [gotchas](docs/gotchas.md).
- Moved-main replay checks and path ownership outcomes are documented in [validator decisions](docs/validator-decisions.md).
- Host checkout writes and acceptance checks participate in the reload drain ([deployment](docs/deployment.md#configuration-and-runtime)).
- Self-repair and task-result notice behavior is summarized in [cross-cutting gotchas](docs/gotchas.md).
- Verification output capture limits are documented in [cross-cutting gotchas](docs/gotchas.md).
- Workflow, UI-kit, and world-simulation internals belong to their [workspace docs](docs/overview.md#workspaces).

## Conventions

- Server implementation belongs in a room server module or package; `server.ts` assembles modules ([architecture](docs/architecture.md#startup-and-service-composition)).
- Cross-room imports use room public indices; packages do not import `src/` ([architecture](docs/architecture.md#dependency-boundaries)).
- Contracts and methods are documented in [RPC and host-call contracts](docs/rpc-callers.md).
- Tasks board and helper-thread graph behavior is documented in [Tasks board](docs/task-board.md).

## Common gotchas

- Thread events wake watchers; fresh reads decide completion, with a fallback poll. Error-status decisions retain a detected BB failure cause ([gotchas](docs/gotchas.md#event-and-polling-behavior)).
- An admitted writer task holds overlapping ownership paths through redos and fallbacks until its writer loop ends ([gotchas](docs/gotchas.md#dispatch-and-retries)).
- OpenCode minimal config can block helper startup while host preparation is pending ([gotchas](docs/gotchas.md#stability-and-local-provider-setup)).
- Host-prepared BB guard wrappers differ for new helpers, owner threads, and older hosts ([native agent](docs/native-agent.md#public-api-or-commands)).
- Live-folder mode has explicit caps and rollback limits ([gotchas](docs/gotchas.md#writer-workspace-modes)).
- Verification worktrees get their own copies of npm state (`node_modules/.bin` and `.package-lock.json`) so `npm install` writes inside the worktree (`src/rooms/verification/git-integrate.ts:594-624`).

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
- [Deployment](docs/deployment.md)
- [Data model](docs/data-model.md)
- [Shared packages](docs/packages.md)
- [Tasks board](docs/task-board.md)
- [Decisions](docs/decisions.md)

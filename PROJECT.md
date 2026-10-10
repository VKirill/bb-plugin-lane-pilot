---
title: Lane Pilot project facts
updated: 2026-10-10
sources:
  - package.json
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - docs/overview.md
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
- Workspace package contracts: [`docs/packages.md`](docs/packages.md).

## Critical invariants

- Startup opens plugin SQLite before composing room services ([`src/rooms/storage/database.ts`](src/rooms/storage/database.ts), [`server.ts`](server.ts)).
- UI RPC schemas and host call schemas are separate ([`docs/rpc-callers.md`](docs/rpc-callers.md)).
- Writer workspace branches and no-Git rollback mode are documented in [ADR 1](docs/decisions.md#adr-1-isolate-writer-workspaces) and [gotchas](docs/gotchas.md).
- Workflow, UI-kit, and world-simulation internals belong to their [workspace docs](docs/overview.md#workspaces).

## Conventions

- Server implementation belongs in a room server module or package; `server.ts` assembles modules ([architecture](docs/architecture.md#startup-and-service-composition)).
- Cross-room imports use room public indices; packages do not import `src/` ([architecture](docs/architecture.md#dependency-boundaries)).
- Contracts and methods are documented in [RPC and host-call contracts](docs/rpc-callers.md).

## Common gotchas

- Thread events wake watchers; fresh reads decide completion, with a fallback poll ([gotchas](docs/gotchas.md#event-and-polling-behavior)).
- OpenCode minimal config can block helper startup while host preparation is pending ([gotchas](docs/gotchas.md#stability-and-local-provider-setup)).
- Live-folder mode has explicit caps and rollback limits ([gotchas](docs/gotchas.md#writer-workspace-modes)).

## Useful commands

- `npm test`
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
- [Decisions](docs/decisions.md)

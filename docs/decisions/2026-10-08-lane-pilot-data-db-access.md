---
title: Protecting Lane Pilot database access
type: decisions
created: 2026-10-08
updated: 2026-10-18
status: active
confidence: medium
tags: [database, access-control, operations]
sources:
  - src/rooms/storage/database.ts
  - lane-stack/hooks/guard_shell.py
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/index.ts
---

# Protecting Lane Pilot database access

TL;DR: Lane Pilot opens its SQLite database through BB storage; access to the database file is an operating-system boundary, not an RPC authorization boundary.

## Context

Lane Pilot obtains its database from `bb.storage.database()`, enables foreign keys, and applies its migrations during `openDatabase` (`src/rooms/storage/database.ts:331-336`). Direct access to that SQLite file can change plugin state outside its RPC handlers. The RPC contract assembles method schemas, and `registerRpc` registers handlers without a caller check (`src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:27-29`). See [RPC and host-call contracts](../rpc-callers.md) for the contract surface.

## Decision

- Protect the database and its containing directory with host filesystem permissions. This repository does not declare or verify the deployed file modes.
- Do not treat Lane Pilot RPC caller identity checks as the database protection. The BB shell guard explicitly leaves Lane Pilot and Env Catalog CLI calls available to PM agents (`lane-stack/hooks/guard_shell.py:54-66`).
- Keep any agent process that can access the host filesystem outside the database directory's permission boundary. The guard allows read-only shell tools to PM readers and Lane Pilot PM agents, while mutating operations are handled by separate policy branches (`lane-stack/hooks/guard_shell.py:31-53`, `:203-215`).

## Status

Active. This record describes the code boundary and the chosen host-permission control; verify deployed file ownership and modes through the host operations procedure.

## Consequences

- RPC validation remains a contract check and does not stop a process with direct filesystem access from changing SQLite data (`src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:27-29`; see [RPC and host-call contracts](../rpc-callers.md)).
- Changes to which processes run on a host or to the database directory's ownership require an operational access review (`src/rooms/storage/database.ts:331-336`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architectural decisions](../decisions.md)

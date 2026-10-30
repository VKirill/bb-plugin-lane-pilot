---
title: Protecting Lane Pilot database access
type: decisions
created: 2026-10-08
updated: 2026-10-30
status: active
confidence: low
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

Lane Pilot obtains its database from `bb.storage.database()`, enables foreign keys, and applies its migrations during `openDatabase` (`src/rooms/storage/database.ts:331-336`). Direct access to that SQLite file can change plugin state outside its RPC handlers. The RPC contract assembles method schemas, and `registerRpc` registers handlers without a caller check (`src/rooms/contracts/index.ts:18-27`, `src/rooms/core/server/rpc.ts:28-30`). See [RPC and host-call contracts](../rpc-callers.md) for the contract surface.

## Decision

- Protect the database and its containing directory with host filesystem permissions. This repository does not declare or verify the deployed file modes.
- Do not treat Lane Pilot RPC caller identity checks as the database protection. The BB shell guard explicitly leaves Lane Pilot and Env Catalog CLI calls available to PM agents (`lane-stack/hooks/guard_shell.py:54-66`).
- Keep any agent process that can access the host filesystem outside the database directory's permission boundary. The guard allows read-only shell tools to PM readers and Lane Pilot PM agents, while mutating operations are handled by separate policy branches (`lane-stack/hooks/guard_shell.py:31-53`, `:203-215`).

## Owner decision (2026-10-08)

These are host facts, not code: the repository cannot cite them, so keep them as written.

- `data.db`, `data.db-shm` and `data.db-wal` on the hub are 0600, and `~/.bb/plugins/lane-pilot` is 0700 (set on 2026-10-08, confirmed in audit round 4).
- No agent process (Claude Code, Codex, OpenCode, Cursor) runs on the hub; threads run on Mac mini, MacBook and OVH. This holds while the hub is not added as a machine, so a periodic `bb host list` belongs in the drill.
- The server caller check and the owner forms for Lane Pilot and Env Catalog RPCs were removed later that day (owner decision «убрать, держать просто», see [RPC callers](../rpc-callers.md)). The file permissions and the absence of agents on the hub are the protection of `data.db`.

**Остающийся риск (принят).** Процесс BB-сервера и всё, что запущено на хабе от `ubuntu`, по-прежнему может писать в БД. Если когда-нибудь агенты будут запускаться на хабе — только под отдельным пользователем без доступа к `~/.bb`.

## Status

Active. This record describes the code boundary and the chosen host-permission control; verify deployed file ownership and modes through the host operations procedure.

## Consequences

- RPC validation remains a contract check and does not stop a process with direct filesystem access from changing SQLite data (`src/rooms/contracts/index.ts:18-27`, `src/rooms/core/server/rpc.ts:28-30`; see [RPC and host-call contracts](../rpc-callers.md)).
- The repository does not define an operational review procedure for host process placement or database-directory ownership; `openDatabase` only obtains BB storage, enables foreign keys, and applies migrations (`src/rooms/storage/database.ts:428-433`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Architectural decisions](../decisions.md)

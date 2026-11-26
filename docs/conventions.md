---
title: Repository conventions and boundaries
type: conventions
created: 2026-11-16
updated: 2026-11-26
status: active
confidence: high
tags: [conventions, architecture, boundaries, migrations, workflow-engine, typescript]
sources:
  - tests/architecture/boundaries.test.ts
  - tests/architecture/file-size.test.ts
  - tests/architecture/foreign-sql.test.ts
  - tests/architecture/room-graph.test.ts
  - tests/architecture/room-layout.test.ts
  - tests/architecture/room-registry.test.ts
  - tests/architecture/one-home.test.ts
  - tests/architecture/no-timers.test.ts
  - tests/migration-lineage.test.ts
  - packages/workflow-engine/src/inbox.ts
  - packages/workflow-engine/src/engine-settle.ts
  - packages/workflow-engine/src/engine-clock.ts
  - packages/workflow-engine/src/engine-start.ts
  - packages/workflow-engine/src/engine-resume.ts
  - packages/workflow-engine/src/validate-rails.ts
  - src/rooms/registry.ts
  - src/rooms/contracts/room.ts
  - .dependency-cruiser.cjs
  - package.json
  - tsconfig.json
  - src/rooms/package.json
  - src/rooms/migrations.ts
  - scripts/check-composer-hook.mjs
---

# Repository conventions and boundaries

TL;DR: Lane Pilot enforces room/package boundaries, room layout, single-home vocabularies, UI-server separation, file size ceilings, append-only migrations, single-clock execution, and SQL table ownership through Vitest architecture gates (`tests/architecture/` and `tests/migration-lineage.test.ts`).

## Directory layout and entries

- Three root TypeScript entry points wire the BB plugin: `server.ts`, `host.ts`, and `app.tsx` (`package.json:16-18`, `tests/architecture/boundaries.test.ts:38`, `:108-113`).
- Every feature subsystem lives in `src/rooms/<room>/` and follows the enforced layout (`tests/architecture/room-layout.test.ts:5-34`, `tests/architecture/room-layout.json` is `[]`):
  - Top level: `index.ts` (runtime-neutral public API), `migrations.ts`, `settings.ts`, `models/`, `server/`, `ui/`.
  - `server/`: `index.ts` (public server API), `room.ts`, `handlers/`, `services/`, `repositories/`.
  - Host-side code importing `fs`, `fs/promises`, or `child_process` stays at room level (`tests/architecture/room-layout.test.ts:8-9`, `:20-27`); `host-worker` keeps `handlers/` at its top level. Cross-cutting rooms (`contracts`, `core`, `storage`) keep their own layout.
- A room offers the plugin its migrations, typed settings, i18n copy, RPC handlers, `bb lane-pilot` verbs, PM tools, and startup wiring by exporting `room: Room<Services>` (`src/rooms/contracts/room.ts:28-43`). `src/rooms/registry.ts:52-95` lists the registered rooms, and `server.ts`, `core/server/rpc.ts`, and `tools` iterate it. A verb is declared once in its room; deleting a room is deleting its folder and its line in the registry. Only `contracts`, `core`, and `tools` sit on `NOT_REGISTERED` in `tests/architecture/room-registry.test.ts:23`. The services bag is one type, `src/rooms/services.ts`.
- Source code under `src/` lives exclusively inside `src/rooms/<room>/`; stray top-level files or folders under `src/` fail `boundaries.test.ts` (`tests/architecture/boundaries.test.ts:115-117`).
- Shared workspaces live under `packages/*` as npm workspaces imported via `@lane-pilot/<name>` (`package.json:101-103`, `tests/architecture/boundaries.test.ts:12`, `:65-81`).
- TypeScript compiles with `strict: true`, `isolatedModules: true`, `noUnusedLocals: true`, and `noEmit: true`; `tsconfig.json` maps `@/*` to the root and pins `@lane-pilot/i18n`, `@lane-pilot/memory-core`, `@lane-pilot/workflow-engine`, and `@lane-pilot/workflow-engine/ui` to their workspace sources so worktrees typecheck local changes instead of stale `node_modules` links (`tsconfig.json:2-24`).

## Room and package import boundaries

| Rule | Enforcement | Target or baseline | Source |
|---|---|---|---|
| Public room entrypoints only | Cross-room imports must target `index.ts`, `server/index.ts`, or `ui/index.ts` | Legacy deep imports tracked in `tests/architecture/deep-imports.json` (may only decrease) | `tests/architecture/boundaries.test.ts:40-41`, `:123-133`; `.dependency-cruiser.cjs:23-28` |
| Packages never import plugin `src/` | Files in `packages/*` may import only their own files or allowed `@lane-pilot/*` dependencies | `PACKAGE_DEPENDENCIES` allowlist (`@contracts`, `@host-calls`, `@workflow-engine`, `@i18n`, `@jev`, `@memory-core`, `@models`, `@settings-catalog`) | `tests/architecture/boundaries.test.ts:26-35`, `:65-81`; `.dependency-cruiser.cjs:16-21` |
| No value-level import cycles | `findCycles` over non-test/non-script production files must be empty | `ALLOW_CYCLES` is empty | `tests/architecture/boundaries.test.ts:23`, `:60-63` |
| Room coupling ratchet | `largestScc` and `mutualPairs` must match the committed baseline | `tests/architecture/room-graph-baseline.json` | `tests/architecture/room-graph.test.ts:18-34` |
| No unresolved relative imports | Every `.` or `..` specifier in `graph.files` must resolve to an existing file | Checked across `src/`, `packages/`, and entries | `tests/architecture/boundaries.test.ts:118-120` |

## UI, backend, and side-effect isolation

- `ui/` modules under `src/rooms/` cannot value-import `server/` modules, and `server/` modules cannot value-import `ui/` modules; type-only imports (`dependencyTypesNot: ["type-only"]`) remain permitted (`tests/architecture/boundaries.test.ts:93-106`, `.dependency-cruiser.cjs:30-40`).
- The browser runtime closure from `app.tsx` cannot import `node:` built-in modules (`tests/architecture/boundaries.test.ts:83-91`, `.dependency-cruiser.cjs:42-47`).
- Backend entries and the shared selection contract (`server.ts`, `host.ts`, `src/rooms/contracts/composer-selection.ts`) must not import `@get-bb/plugin-sdk/app`, checked by `npm run check:composer-hook` (`scripts/check-composer-hook.mjs:4-12`, `package.json:94`).
- Room modules have no top-level import-time side effects unless explicitly registered in `src/rooms/package.json` `sideEffects` (`src/rooms/package.json:4-25`, `tests/architecture/boundaries.test.ts:135-155`).

## Engine primitives and invariants

- **Event inbox**: `emitEvent` (`src/rooms/workflow/server/services/workflow-triggers.ts:289-356`) writes to the append-only `lane_pilot_wf_inbox` table via `insertInboxEvent` (`INSERT OR IGNORE` keyed by idempotency `id`, `packages/workflow-engine/src/inbox.ts:49-57`) before matching waiting steps or starting graphs with `{ type: "event" }` triggers. An event that arrives before a wait parks stays unconsumed until claimed (`claimUnconsumedInboxEvent`, `inbox.ts:84-113`), duplicate ids are ignored, and `attemptMatches` (`inbox.ts:73-81`) rejects stale events for earlier attempts. Canonical event names live in `LP_EVENTS` (`packages/contracts/src/events.ts`).
- **Absolute deadlines**: waiting steps (`builtin:wait`, `builtin:human`, `lp-task`) record an absolute epoch millisecond `deadline` in `lane_pilot_wf_step.await_json` at park time (`packages/workflow-engine/src/engine-builtins.ts:103-142`); deadlines are never recomputed on resume (`engine-resume.ts:98-148`). Any `human` node without its own `timeoutSec` receives the 72-hour default (`HUMAN_WAIT_DEFAULT_SEC`, `engine-builtins.ts:16-23`).
- **Compare-and-set wake**: `settle` (`packages/workflow-engine/src/engine-settle.ts:12-120`) and `journal.moveStep` transition a waiting step inside one SQLite transaction guarded by `state = 'waiting'`, so an arriving event and an expired deadline cannot both fire for the same step. Parking executors are not re-run on resume (`engine-resume.ts:44-92`).
- **Timeout output on every wait**: `validateWorkflowRails` (`packages/workflow-engine/src/validate-rails.ts:91-185`) requires every waiting node (`builtin:wait`, `builtin:human`, `lp-task`) to declare a deadline (own or default) and an outgoing edge accepting its timeout output (`{ woke: "timeout", ... }` for `builtin:wait`, `humanTimeoutOutcome` for `human`, blocked outcome for `lp-task`). It also rejects skipped check nodes whose `skip_out` outputs a pass value instead of `not_run`, and rejects judge nodes taking a worker session (`pass` in `same-session | read-prior-session | fork`).
- **Snapshot per run**: `start` lowers child subworkflows, pins them, and stores `definition_json` on `lane_pilot_wf_run` (`packages/workflow-engine/src/engine-start.ts:60-68`). `engine.compiled` executes strictly from that stored snapshot; an unreadable snapshot fails with `SnapshotMissingError` (`snapshot_missing`, `engine.ts:87-96`) instead of reading the current library (`tests/workflow/graph-snapshot.test.ts`). Because in-flight runs keep old snapshots and completed steps stay in the journal for visit counting, step types and their params change additively only.
- **One clock**: `startClock` (`packages/workflow-engine/src/engine-clock.ts:63-128`) runs one `setTimeout` armed to `MIN(deadline)` over waiting steps (`nextStepDeadline`) and due schedule-board rows (`ClockBoard.nextDueAt`), re-armed on every park, wake, and board change, bounded by `CLOCK_BEAT_MS` (60 s, stamping `outage:beat`) and `DEFAULT_OVERDUE_CAP` (25 overdue items per tick). `startBoardClock` (`src/rooms/schedule/server/handlers/board-clock.ts:10-25`) mounts it behind the plugin's single `scheduleIsolated` (`engine-clock`); `tests/architecture/no-timers.test.ts:44-81` forbids any other `scheduleIsolated`, `bb.background.schedule`, `experimental_vkSchedule`, or ad-hoc `engine.poll()`/`workflowEngine.poll()` calls. Setting `schedule.paused_all` stops the clock from firing steps or board rows while keeping waits parked.
- **Room registry**: every room with a `server/` folder (outside `contracts`, `core`, `tools`) exports `room` (`src/rooms/contracts/room.ts`) and appears in `src/rooms/registry.ts`; `tests/architecture/room-registry.test.ts` checks uniqueness of room names, CLI verbs, and RPC keys, and verifies each room's `migrations` slice stays contiguous in `src/rooms/migrations.ts`.
- **One home per vocabulary**: shared statuses, limits, patterns, and contracts live in a single owning module guarded by `tests/architecture/one-home.test.ts:32-135`: terminal attempt states in `src/rooms/contracts/state-machine.ts`, the test-path regex in `src/rooms/tasks/models/rails.ts`, `process.env.BB_HOST_ID` reads in `packages/kit/src/env.ts`, `HELPER_ROLES` 1:1 parity with `lane-stack/hooks/guard_shell.py`, `MODEL_PRICES` in `@lane-pilot/models`, mandatory `reason` on `postOwnerItem`, and shipped graph categories in `packages/contracts/src/graph-categories.ts`.
- **Graphs are data by choice**: shipped workflows are JSON files under `workflows/*.json` rather than TypeScript modules, loaded from disk by `src/rooms/workflow/builtin.ts:74-131`. Every shipped graph requires a known `category` (`validate.ts:83-89`) and `description`/`not_for` metadata so the PM catalog groups and chooses graphs without code edits.

## File size limits

- Non-test TypeScript files under `src/rooms`, `packages`, and root entries (`server.ts`, `host.ts`, `app.tsx`) are limited to `LIMIT` = 500 lines (`tests/architecture/file-size.test.ts:13`, `:31-34`).
- Generated sources, i18n dictionaries, and the append-only migration files are listed in `EXEMPT` (`tests/architecture/file-size.test.ts:16-21`).
- Pre-existing oversized files carry per-file line ceilings (rounded up to 100) in `tests/architecture/file-size.json`; ceilings can only decrease (`tests/architecture/file-size.test.ts:28`, `:37-48`).

## Database migrations and SQL ownership

- `migrations` in `src/rooms/migrations.ts` is positional and append-only (`src/rooms/migrations.ts:2-3`); `ATTEMPT_LEDGER_TRIGGERS` enforces append-only rows on `lane_pilot_attempt_transition` and `lane_pilot_attempt` (`src/rooms/migrations.ts:45-50`). Slices from retired rooms remain frozen verbatim in `src/rooms/legacy-migrations.ts` so existing databases keep matching statement indices.
- Every statement hash at every index is locked in `tests/fixtures/migrations.lock.json`; new SQL statements go at the end of `migrations` with their SHA-256 appended to the lock file (`tests/migration-lineage.test.ts:34-43`).
- Cross-room raw `.prepare(` SQL calls touching tables owned by another room are ratcheted down via `tests/architecture/foreign-sql-baseline.json` (`tests/architecture/foreign-sql.test.ts:17-27`).
- `node:sqlite` may not be imported anywhere under `src/` so the plugin server process never opens a second SQLite driver alongside BB's `better-sqlite3` connection (`tests/architecture/foreign-sql.test.ts:34-39`).

## Updating architectural baselines

- After splitting an oversized file, removing a deep import, or eliminating a foreign SQL site or room cycle, lower the committed baselines with `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` (`tests/architecture/boundaries.test.ts:127`, `tests/architecture/file-size.test.ts:37`, `tests/architecture/foreign-sql.test.ts:20`, `tests/architecture/room-graph.test.ts:21`).
- Human-readable dependency reports run via `npm run check:deps` (uses `dependency-cruiser`, excluding cycle checks on type-only edges; `.dependency-cruiser.cjs:1-4`, `package.json:95`).

## Related pages

- [Lane Pilot architecture](architecture.md)
- [Shared packages](packages.md)
- [Lane Pilot data model overview](data-model.md)
- [Testing and verification](testing.md)
- [Development](guide/development.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Testing and verification](testing.md)

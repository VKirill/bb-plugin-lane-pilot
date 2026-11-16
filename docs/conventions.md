---
title: Repository conventions and boundaries
type: conventions
created: 2026-11-16
updated: 2026-11-16
status: active
confidence: medium
tags: [conventions, architecture, boundaries, migrations, typescript]
sources:
  - tests/architecture/boundaries.test.ts
  - tests/architecture/file-size.test.ts
  - tests/architecture/foreign-sql.test.ts
  - tests/architecture/room-graph.test.ts
  - tests/migration-lineage.test.ts
  - .dependency-cruiser.cjs
  - package.json
  - tsconfig.json
  - src/rooms/package.json
  - src/rooms/migrations.ts
  - scripts/check-composer-hook.mjs
---

# Repository conventions and boundaries

TL;DR: Lane Pilot enforces room/package boundaries, UI-server separation, file size ceilings, append-only migrations, and SQL table ownership through Vitest architecture gates (`tests/architecture/boundaries.test.ts:9-16`, `tests/migration-lineage.test.ts:34-43`).

## Directory layout and entries

- Three root TypeScript entry points wire the BB plugin: `server.ts`, `host.ts`, and `app.tsx` (`package.json:10-19`, `tests/architecture/boundaries.test.ts:38`, `:108-113`).
- Source code under `src/` lives exclusively inside `src/rooms/<room>/`; stray top-level files or folders under `src/` fail `boundaries.test.ts` (`tests/architecture/boundaries.test.ts:115-117`).
- Shared workspaces live under `packages/*` as npm workspaces imported via `@lane-pilot/<name>` (`package.json:103-105`, `tests/architecture/boundaries.test.ts:12`, `:73-77`).
- TypeScript compiles with `strict: true`, `isolatedModules: true`, and `noEmit: true`; `tsconfig.json` maps `@/*` to the root and pins `@lane-pilot/i18n`, `@lane-pilot/council`, and `@lane-pilot/memory-core` to their workspace sources so worktrees typecheck local changes instead of stale `node_modules` links (`tsconfig.json:2-21`).

## Room and package import boundaries

| Rule | Enforcement | Target or baseline | Source |
|---|---|---|---|
| Public room entrypoints only | Cross-room imports must target `index.ts`, `server/index.ts`, or `ui/index.ts` | Legacy deep imports tracked in `tests/architecture/deep-imports.json` (may only decrease) | `tests/architecture/boundaries.test.ts:40-41`, `:123-133`; `.dependency-cruiser.cjs:23-28` |
| Packages never import plugin `src/` | Files in `packages/*` may import only their own files or allowed `@lane-pilot/*` dependencies | `PACKAGE_DEPENDENCIES` allowlist (`@contracts`, `@host-calls`, `@workflow-engine`, `@i18n`, `@jev`, `@memory-core`, `@run-insights`, `@settings-catalog`) | `tests/architecture/boundaries.test.ts:26-35`, `:65-81`; `.dependency-cruiser.cjs:16-21` |
| No value-level import cycles | `findCycles` over non-test/non-script production files must be empty | `ALLOW_CYCLES` is empty | `tests/architecture/boundaries.test.ts:23`, `:60-63` |
| Room coupling ratchet | `largestScc` and `mutualPairs` must match the committed baseline | `tests/architecture/room-graph-baseline.json` | `tests/architecture/room-graph.test.ts:18-34` |
| No unresolved relative imports | Every `.` or `..` specifier in `graph.files` must resolve to an existing file | Checked across `src/`, `packages/`, and entries | `tests/architecture/boundaries.test.ts:118-120` |

## UI, backend, and side-effect isolation

- `ui/` modules under `src/rooms/` cannot value-import `server/` modules, and `server/` modules cannot value-import `ui/` modules; type-only imports (`dependencyTypesNot: ["type-only"]`) remain permitted (`tests/architecture/boundaries.test.ts:93-106`, `.dependency-cruiser.cjs:30-40`).
- The browser runtime closure from `app.tsx` cannot import `node:` built-in modules (`tests/architecture/boundaries.test.ts:83-91`, `.dependency-cruiser.cjs:42-47`).
- Backend entries and the shared selection contract (`server.ts`, `host.ts`, `src/rooms/contracts/composer-selection.ts`) must not import `@get-bb/plugin-sdk/app`, checked by `npm run check:composer-hook` (`scripts/check-composer-hook.mjs:4-12`, `package.json:92`).
- Room modules have no top-level import-time side effects unless explicitly registered in `src/rooms/package.json` `sideEffects` (`src/rooms/package.json:4-25`, `tests/architecture/boundaries.test.ts:135-155`).

## File size limits

- Non-test TypeScript files under `src/rooms`, `packages`, and root entries (`server.ts`, `host.ts`, `app.tsx`) are limited to `LIMIT` = 500 lines (`tests/architecture/file-size.test.ts:13`, `tests/architecture/file-size.test.ts:31-34`).
- Generated maps, i18n dictionaries, and the append-only migration file are listed in `EXEMPT` (`tests/architecture/file-size.test.ts:16-21`).
- Pre-existing oversized files carry per-file line ceilings (rounded up to 100) in `tests/architecture/file-size.json`; ceilings can only decrease (`tests/architecture/file-size.test.ts:28`, `:37-48`).

## Database migrations and SQL ownership

- `migrations` in `src/rooms/migrations.ts` is positional and append-only (`src/rooms/migrations.ts:1-2`, `:40-41`); `ATTEMPT_LEDGER_TRIGGERS` enforces append-only rows on `lane_pilot_attempt_transition` and `lane_pilot_attempt` (`src/rooms/migrations.ts:35-39`).
- Every statement hash at every index is locked in `tests/fixtures/migrations.lock.json`; new SQL statements go at the end of `migrations` with their SHA-256 appended to the lock file (`tests/migration-lineage.test.ts:34-43`).
- Cross-room raw `.prepare(` SQL calls touching tables owned by another room are ratcheted down via `tests/architecture/foreign-sql-baseline.json` (`tests/architecture/foreign-sql.test.ts:17-27`).
- `node:sqlite` may be imported only by `rooms/anamnesis/store.ts` so the plugin server process never opens a second SQLite driver alongside BB's `better-sqlite3` connection (`tests/architecture/foreign-sql.test.ts:35-40`).

## Updating architectural baselines

- After splitting an oversized file, removing a deep import, or eliminating a foreign SQL site or room cycle, lower the committed baselines with `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` (`tests/architecture/boundaries.test.ts:127`, `tests/architecture/file-size.test.ts:37`, `tests/architecture/foreign-sql.test.ts:20`, `tests/architecture/room-graph.test.ts:21`).
- Human-readable dependency reports run via `npm run check:deps` (uses `dependency-cruiser`, excluding cycle checks on type-only edges; `.dependency-cruiser.cjs:1-4`, `package.json:93`).

## Related pages

- [Lane Pilot architecture](architecture.md)
- [Shared packages](packages.md)
- [Lane Pilot data model overview](data-model.md)
- [Testing and verification](testing.md)
- [Development](guide/development.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Testing and verification](testing.md)

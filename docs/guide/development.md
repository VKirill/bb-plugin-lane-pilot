---
title: Development
topic: development
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, development]
updated: 2026-11-26
sources:
  - package.json
  - vitest.config.ts
  - src/rooms/migrations.ts
  - src/rooms/storage/database.ts
  - scripts/lp-drill.py
  - tests/helpers/git-repo.ts
---

# Development

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## Layout

| Path | What lives there |
|---|---|
| `server.ts`, `host.ts`, `app.tsx` | The three BB entries. They only assemble: server wiring and RPC in `server.ts`, host handlers in `host.ts`, the React app in `app.tsx`. |
| `src/rooms/<room>/` | One folder per subsystem (`writer`, `runs`, `critique`, `memory`, `workflow`, `settings`, `ui-shell`, `errands`, `evolve`, `lead`, and more), registered in `src/rooms/registry.ts` (`Room` contract in `src/rooms/contracts/room.ts`). Standard room layout (enforced by `tests/architecture/room-layout.test.ts`): `index.ts` (public contract/types), `migrations.ts`, `settings.ts`, `models/` (pure domain logic), `server/{index.ts, room.ts, handlers/, services/, repositories/}`, `ui/` (`ui/index.ts`), plus host modules at room level. Cross-cutting primitives live in `contracts/`, `core/` and `storage/`. |
| `packages/*` | 12 npm workspaces under `@lane-pilot/`: `contracts`, `handoff`, `host-calls`, `i18n`, `kit`, `memory-core`, `models`, `resilience`, `settings-catalog`, `thread-observe`, `ui-kit`, `workflow-engine`. Six keep their own workspace docs (`i18n`, `kit`, `memory-core`, `models`, `ui-kit`, `workflow-engine`); the rest belong to root `docs/`. |
| `workflows/` | The shipped graphs (JSON, categorized under `packages/contracts/src/graph-categories.ts`). |
| `lane-stack/` | Guard hooks, the OpenCode `opencode-lane` plugin, bin helpers and schemas installed on hosts for writer and helper sessions. |
| `policy/` | JSON policy files (calendar, exams, external skills). |
| `scripts/` | Drill, canary, metrics, atlas and settings generators, test wrappers. |
| `docs/` | Living documentation, see the [index](../../README.md#documentation-map). |
| `tests/` | The root test suite; rooms and packages may also keep tests next to their code. |

**Import boundaries** (enforced by `tests/architecture/boundaries.test.ts`, with a deep-import baseline in `tests/architecture/deep-imports.json`): code in one room imports another room only through its public files; packages never import from `src/`; rooms are free of import-time effects so a barrel does not pull unused files into a bundle (files that must run on import are listed in `src/rooms/package.json`). `npm run check:deps` runs dependency-cruiser over the tree.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies and links the workspaces. |
| `npx vitest run` (`npm test`) | The full suite. Vitest runs four projects: `node` (`isolate: false`, one module graph per worker), `node-isolated` (`mocking` list for `vi.mock` or module-level state), `ui` (`isolate: false`, jsdom) and `ui-isolated` (`uiAlone` pages that cannot share a document), longest file first on half the cores (`maxWorkers: "50%"`). |
| `npm run test:changed` | Only tests that changed, tests whose imports match changed sources, and tests of a changed package. `-- --graph` uses Vitest's changed dependency graph. Writes no deploy receipt. |
| `scripts/test-full.sh` | The full suite once per code state: on green and a clean tree it writes the receipt the deploy script checks, keyed by the tree of `HEAD` and the Node version. |
| `node scripts/test-timing.mjs` | Summarizes Vitest's cached per-file timings (`node_modules/.vite/vitest/*/results.json` or a given path; supports `--top N` and `--json`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | `bb plugin build` (server, host and app bundles). |
| `npm run test:layout` | The layout checks of the UI (`tests/layout/run.mjs`). |
| `npm run check` | `npm test`, typecheck, build and layout tests in sequence. |

**How the suite runs.** `vitest.config.ts` splits tests into four projects (`node`, `node-isolated`, `ui`, `ui-isolated`) scheduled by `tests/sequencer.ts` (longest file first) across `maxWorkers: "50%"` (half the cores). Both `node` and `ui` run with `isolate: false` (one module graph per worker; `tests/setup-jsdom.ts` resets `process.env` and `cwd` between files). Add a file to the `mocking` list in `vitest.config.ts` with a one-line reason when it calls `vi.mock`/`vi.doMock` (enforced by `tests/architecture/mocking-isolated.test.ts`) or depends on empty module-level state; do not mutate `LOG_LEVEL` mid-run (read once at entry in `initRuntimeEnv` — pass it as a parameter instead). `bb-plugin-push` (in `infrastructure/plugin-deploy`, outside this repo) runs checks under `nice -n 10`, and on `ovh-ci` under `systemd-run --user --scope -p CPUQuota=800% -p MemoryMax=8G` (8 of 16 cores, 8 GB; measured peak 5.9 GB). Measure slow files with `node scripts/test-timing.mjs`, and create temporary git repositories in tests with `tests/helpers/git-repo.ts` (`createGitRepo`, `git`).

**Where to run what.** Parallel agents and quick edits run only their own tests. The tests that start git repositories, spawn processes or build worktrees (`tests/verification/**`, `tests/scenarios.test.ts`, `tests/pipeline*.test.ts`, `tests/acceptance-v2.test.ts`) must run outside the Lane Pilot check sandbox: inside a task's own sandboxed check they cannot run, which is what `verification.sandbox_unsafe` is for (a whole-suite check must exclude them with `--exclude`, and the contract lint refuses one that does not). A task's check should be the focused one (for example `npx vitest related <files> --run`); the whole suite is the integration gate's, once per batch. Vitest leaks temporary directories on a busy machine; `tests/global-setup.ts` gives each run one temp directory and removes it afterwards, but check free disk before a full run.

## Database migrations

The plugin's SQLite schema is one positional `migrations` array in `src/rooms/migrations.ts`, assembled from `src/rooms/legacy-migrations.ts` (frozen statements kept so existing indices never shift), the rooms' `room.migrations` lists in `src/rooms/registry.ts`, and package migrations, applied at startup by `openDatabase` in `src/rooms/storage/database.ts`. It is **append-only**: the hub records every applied statement by index and refuses a plugin whose statement at an index differs. Add a new statement at the end of the array (never inside a package or room list spread in the middle) and add its SHA-256 to `tests/fixtures/migrations.lock.json`; `tests/migration-lineage.test.ts` fails when a locked statement moved or changed and when a new one has no hash. See [docs/data-model.md](../data-model.md).

## Deploy

A path plugin runs from the hub's own copy of its folder, so a rebuild on a development machine reaches BB only through the deploy script, `bb-plugin-push lane-pilot` (the infrastructure repository's `plugin-deploy` folder, outside this repository); `lp-deploy` is its wrapper for the OVH development machine. In order: a gate (a clean tree with HEAD already in origin), the full test suite (or its receipt), a drain of in-flight checkout writes and acceptance checks, the build, a copy of the previous build for rollback, rsync to the hub, a dist-hash check, `bb plugin reload`, a version and hash check, and then **the drill**: `scripts/lp-drill.sh --quick` against the deployed version runs the checks without models, about 35 seconds (shell guard hashes on each host, the deferral register, the checkers drill, `memory_paths`, `helper_providers` and `parallel3`). The live scenarios (three parallel tasks accepted in separate worktrees, the helper probe per provider, the memory paths) run in the nightly drill, `infrastructure/plugin-deploy/lp-drill-nightly` from cron on OVH, which reports a red run to the thread; `LP_DRILL_LIVE=1` runs them in a deploy too. See the header of `scripts/lp-drill.py`. A red drill or any failure after rsync rolls the hub back to the previous build and, when migrations were applied, to a database snapshot. The drain, reload recovery and the snapshot are described in [docs/deployment.md](../deployment.md).

Release notes of every version are in [CHANGELOG.md](../../CHANGELOG.md); ADRs are in [docs/decisions.md](../decisions.md); cross-cutting traps are in [docs/gotchas.md](../gotchas.md).

## Sources

Where this page's claims start in the code: `package.json:1-21`, `vitest.config.ts:6-79`, `src/rooms/migrations.ts:1-60`, `src/rooms/storage/database.ts:20-26`, `scripts/lp-drill.py:123-143`, `tests/helpers/git-repo.ts:1-67`. The deep pages linked above cite the rest.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Repository conventions and boundaries](../conventions.md)
- [Testing and verification](../testing.md)

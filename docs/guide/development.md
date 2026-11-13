---
title: Development
topic: development
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, development]
updated: 2026-11-06
sources:
  - package.json
  - src/rooms/storage/database.ts
  - scripts/lp-drill.py
---

# Development

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## Layout

| Path | What lives there |
|---|---|
| `server.ts`, `host.ts`, `app.tsx` | The three BB entries. They only assemble: server wiring and RPC in `server.ts`, host handlers in `host.ts`, the React app in `app.tsx`. |
| `src/rooms/<room>/` | One folder per subsystem (writer, runs, critique, memory, wall, bench, harness, council, workflow, settings, ui-shell and many more). A room exposes three public files: `index.ts` (domain), `server/index.ts` and `ui/index.ts`. Everything else in the room is private. |
| `packages/*` | npm workspaces under the `@lane-pilot/` scope: `contracts`, `council`, `handoff`, `harness-core`, `host-calls`, `i18n`, `kit`, `memory-core`, `models`, `pixel-world`, `resilience`, `run-insights`, `settings-catalog`, `thread-observe`, `ui-kit`, `workflow-engine`, `world-sim`. Four of them have their own `docs/` (`i18n`, `ui-kit`, `workflow-engine`, `world-sim`). |
| `workflows/` | The shipped graphs (JSON). |
| `lane-stack/` | Guard hooks, the OpenCode `opencode-lane` plugin, bin helpers and schemas installed on hosts for writer and helper sessions. |
| `policy/`, `bench/` | The night policy and its exam; the bench task sources (`known-bugs-v1.json`, `real-prs-v1.json`). |
| `scripts/` | Drill, canary, metrics, bench, atlas and settings generators, test wrappers. |
| `docs/` | Living documentation, see the [index](../../README.md#documentation-map). |
| `tests/` | The root test suite; rooms and packages may also keep tests next to their code. |

**Import boundaries** (enforced by `tests/architecture/boundaries.test.ts`, with a deep-import baseline in `tests/architecture/deep-imports.json`): code in one room imports another room only through its public files; packages never import from `src/`; rooms are free of import-time effects so a barrel does not pull unused files into a bundle (files that must run on import are listed in `src/rooms/package.json`). `npm run check:deps` runs dependency-cruiser over the tree.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Installs dependencies and links the workspaces. |
| `npx vitest run` (`npm test`) | The full suite. Vitest runs four projects: `node` (shared module graph), `node-isolated` (files that use `vi.mock`), `ui` and `ui-isolated` (jsdom; pages that cannot share a document), longest file first. |
| `npm run test:changed` | Only tests that changed, tests whose imports match changed sources, and tests of a changed package. `-- --graph` uses Vitest's changed dependency graph. Writes no deploy receipt. |
| `scripts/test-full.sh` | The full suite once per code state: on green and a clean tree it writes the receipt the deploy script checks, keyed by the tree of `HEAD` and the Node version. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | `bb plugin build` (server, host and app bundles). |
| `npm run test:layout` | The layout checks of the UI (`tests/layout/run.mjs`). |
| `npm run check` | `npm test`, typecheck, build and layout tests in sequence. |

**Where to run what.** Parallel agents and quick edits run only their own tests. The tests that start git repositories, spawn processes or build worktrees (`tests/verification/**`, `tests/scenarios.test.ts`, `tests/pipeline*.test.ts`, `tests/acceptance-v2.test.ts`) must run outside the Lane Pilot check sandbox: inside a task's own sandboxed check they cannot run, which is what `verification.sandbox_unsafe` is for (a whole-suite check must exclude them with `--exclude`, and the contract lint refuses one that does not). A task's check should be the focused one (for example `npx vitest related <files> --run`); the whole suite is the integration gate's, once per batch. Vitest leaks temporary directories on a busy machine; `tests/global-setup.ts` gives each run one temp directory and removes it afterwards, but check free disk before a full run.

## Database migrations

The plugin's SQLite schema is one positional array in `src/rooms/storage/database.ts`, assembled from the rooms' and packages' migration lists. It is **append-only**: the hub records every applied statement by index and refuses a plugin whose statement at an index differs. Add a new statement at the end of the array (never inside a package list spread in the middle) and add its SHA-256 to `tests/fixtures/migrations.lock.json`; `tests/migration-lineage.test.ts` fails when a locked statement moved or changed and when a new one has no hash. See [docs/data-model.md](../data-model.md).

## Deploy

A path plugin runs from the hub's own copy of its folder, so a rebuild on a development machine reaches BB only through the deploy script, `bb-plugin-push lane-pilot` (the infrastructure repository's `plugin-deploy` folder, outside this repository); `lp-deploy` is its wrapper for the OVH development machine. In order: a gate (a clean tree with HEAD already in origin), the full test suite (or its receipt), a drain of in-flight checkout writes and acceptance checks, the build, a copy of the previous build for rollback, rsync to the hub, a dist-hash check, `bb plugin reload`, a version and hash check, and then **the drill**: `scripts/lp-drill.sh --quick` against the deployed version runs the checks without models, about 35 seconds (shell guard hashes on each host, the deferral register, the checkers drill, the lead and episode checks). The live scenarios (three parallel tasks accepted in separate worktrees, the helper probe per provider, the memory paths) run in the nightly drill, `infrastructure/plugin-deploy/lp-drill-nightly` from cron on OVH, which reports a red run to the thread; `LP_DRILL_LIVE=1` runs them in a deploy too. See the header of `scripts/lp-drill.py`. A red drill or any failure after rsync rolls the hub back to the previous build and, when migrations were applied, to a database snapshot. The drain, reload recovery and the snapshot are described in [docs/deployment.md](../deployment.md).

Release notes of every version are in [CHANGELOG.md](../../CHANGELOG.md); ADRs are in [docs/decisions.md](../decisions.md); cross-cutting traps are in [docs/gotchas.md](../gotchas.md).

## Sources

Where this page's claims start in the code: `package.json:1-21`, `src/rooms/storage/database.ts:48-68`, `scripts/lp-drill.py:123-143`. The deep pages linked above cite the rest.

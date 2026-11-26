---
title: Testing and verification
type: testing
created: 2026-11-16
updated: 2026-11-24
status: active
confidence: medium
tags: [testing, vitest, playwright, verification, sma]
sources:
  - vitest.config.ts
  - package.json
  - scripts/test-changed.mjs
  - scripts/test-full.sh
  - tests/sequencer.ts
  - tests/global-setup.ts
  - tests/setup-jsdom.ts
  - tests/setup-shared-modules.ts
  - tests/architecture/mocking-isolated.test.ts
  - tests/layout/run.mjs
  - tsconfig.json
  - scripts/check-composer-hook.mjs
  - .dependency-cruiser.cjs
---

# Testing and verification

TL;DR: Vitest runs four projects (`node`, `node-isolated`, `ui`, `ui-isolated`) sorted longest-first, supplemented by changed-file selection (`test:changed`), clean-tree full-suite receipts (`scripts/test-full.sh`), Playwright UI layout checks, and SMA contract/mutation checks (`vitest.config.ts:64-83`, `package.json:89-104`).

## Vitest projects and isolation

| Project | Files matched | Isolation and setup | Source |
|---|---|---|---|
| `node` | `tests/**/*.test.ts`, `src/rooms/**/tests/**/*.test.ts`, `packages/*/tests/**/*.test.ts` (excluding `mocking`) | `isolate: false` (one module graph per worker); runs `setup-jsdom.ts` and `setup-shared-modules.ts` | `vitest.config.ts:39`, `:75`; `tests/setup-shared-modules.ts:1` |
| `node-isolated` | Files listed in `mocking` (calls to `vi.mock`/`vi.doMock` or module-level state) | Isolated module graph per file; enforced by `mocking-isolated.test.ts` | `vitest.config.ts:7-38`, `:76`; `tests/architecture/mocking-isolated.test.ts:14-21` |
| `ui` | `tests/**/*.test.tsx`, `src/rooms/**/tests/**/*.test.tsx` (excluding `uiAlone`) | `isolate: false` with `uiTests` and jsdom `vi.resetModules()` per file | `vitest.config.ts:41-42`, `vitest.config.ts:77`; `tests/setup-jsdom.ts:6` |
| `ui-isolated` | Page tests listed in `uiAlone` that require a clean document | Isolated per file | `vitest.config.ts:41`, `:78` |

- `testTimeout` is `60000` ms (`vitest.config.ts:61`); `maxWorkers` is `50%` of the cores (`vitest.config.ts:64`).
- `LongestFirstSequencer` schedules all projects from a single queue (failed files first, then longest cached duration, then largest file size) unless `LP_DEFAULT_ORDER` is set (`vitest.config.ts:66`, `tests/sequencer.ts:12-29`).
- `workspaceAliases` maps every `@lane-pilot/*` package export to its local directory under `packages/` so tests in a git worktree execute that worktree's code instead of `node_modules` links (`vitest.config.ts:47`, `:82`).

## Test runtime environment

- `tests/global-setup.ts` creates one per-run temporary root (`lp-vitest-<pid>-`), assigns `TMPDIR`, `TEMP`, and `TMP`, sweeps directories from dead PIDs, removes the run directory on teardown, and sets `LANE_PILOT_OWNER_WORDS_DEFAULT ??= "off"` (`tests/global-setup.ts:9-38`).
- `vitest.config.ts` sets `LANE_PILOT_AGY_BIN: ""` so tests never invoke the external Antigravity CLI (`vitest.config.ts:73`).
- `tests/setup-jsdom.ts` restores `process.env` and `process.cwd()` between files, stubs `ResizeObserver`, `scrollIntoView`, pointer capture, and `matchMedia`, caches footer locale marker lookups, and defaults `LANE_PILOT_HOST_JOBS="0"`, `LANE_PILOT_THREAD_SIGNALS="0"`, and `LANE_PILOT_POLL_SCALE="0.05"` (`tests/setup-jsdom.ts:10-70`). Set `LP_TEST_RESET=1` to force `vi.resetModules()` before every node test file (`tests/setup-jsdom.ts:4-6`).

## Verification commands

| Command | Behavior | Source |
|---|---|---|
| `npm test` | Runs `vitest run` across all four projects | `package.json:90` |
| `npm run test:changed` | Selects tests for dirty files vs `HEAD` (or clean branch commits vs `main`/`origin/main`) by changed test paths, direct importers (filtered by `touchedIdentifiers` when >15 tests import a file), package suites, and literal file/basename mentions; exits `2` when non-inert changed files have no owning test | `package.json:91`; `scripts/test-changed.mjs:47-63`, `:87-182`, `:209-217` |
| `npm run test:changed -- --graph` | Runs `vitest run --changed <base>` plus literal-referenced suites; add `--list` to print without running | `scripts/test-changed.mjs:38-41`, `:184-207` |
| `scripts/test-full.sh` | Runs full `vitest run`; writes a deploy receipt keyed by `<HEAD^{tree}>-<node -v>` in `$LP_TEST_RECEIPTS` (default `$HOME/.lane-pilot/test-receipts`) only when started and finished on a clean tree | `scripts/test-full.sh:12-71` |
| `npm run typecheck` | Runs `tsc --noEmit` across root entries, `src`, `tests`, `packages`, and `scripts/lp_drill/scenes` | `package.json:92`; `tsconfig.json:23` |
| `npm run build` | Runs `bb plugin build` for server, host, and app bundles | `package.json:93` |
| `npm run test:layout` | Runs `tests/layout/run.mjs`: launches Playwright Chromium against a local HTML fixture using `dev-orchestrator` (`src/rooms/contracts/bundled-agents.json`) across 6 width/sidebar/theme cases in `en` and `ru`, asserting `collectPanelGeometry` passes with no overflow | `package.json:96`; `tests/layout/run.mjs:7-24`, `tests/layout/run.mjs:182-242` |
| `npm run check` | Runs `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:layout` sequentially | `package.json:101` |
| `npm run check:composer-hook` | Verifies `server.ts`, `host.ts`, and `composer-selection.ts` do not import `@get-bb/plugin-sdk/app` | `package.json:94`; `scripts/check-composer-hook.mjs:5-11` |
| `npm run check:deps` | Runs `dependency-cruiser` over `server.ts`, `host.ts`, `app.tsx`, `src`, and `packages` | `package.json:95`; `.dependency-cruiser.cjs:1-13` |
| `npm run sma:facts:check` / `npm run sma:mutate` | Verifies `hollow-facts.json`, `provenance.json`, and `contracts.ts`; runs mutation kills against `[sma:<id>]` contract tests | `package.json:97-100` |

## Continuous integration

- The repository has no hosted CI. Checks run on the maintainer's own Linux runner before every deploy: `npx tsc --noEmit -p .` plus `npm run test:changed` against the last fully green commit, and the full `npx vitest run` at least once a day or when dependencies, vitest or TypeScript configs change.
- Reference environment for a green suite: Linux, Node `24.15.0`, `bubblewrap` and `sqlite3` installed, Playwright Chromium, full git history with a local `main` branch (parity and bisect tests read `main`), `NO_COLOR=1` and `VITE_CONFIG_NATIVE_IGNORE_WARNING=true`.
- macOS and Windows are not reference platforms: Linux-only tests (bash, `bwrap`, systemd, crontab) fail there by design.

## Related pages

- [Repository conventions](conventions.md)
- [Build and deploy Lane Pilot](deployment.md)
- [Cross-cutting gotchas](gotchas.md)
- [Development](guide/development.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Repository conventions and boundaries](conventions.md)
- [Build and deploy Lane Pilot](deployment.md)

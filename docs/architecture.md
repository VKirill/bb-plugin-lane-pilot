---
title: Lane Pilot architecture and the road to it
status: active
owner: AG-190 Lane Pilot
started: 2026-09-30
---

# Lane Pilot architecture

> [!NOTE]
> This page is the map. It says where code lives, what may depend on what, and in which order the
> plugin was moved from one 7 000-line `server.ts` into modules, rooms and reusable packages.
> The rules in [Rules](#rules) apply to every change from 2026-09-30 on.

## Layout

```text
bb-plugin-lane-pilot/
├── server.ts  host.ts  app.tsx   entries: mount room faces, no logic (bb plugin build reads them from package.json "bb")
├── packages/                     shared code, imported by name (@lane-pilot/<name>), never imports src/
│   ├── kit/                      hash (sha256Hex), redact, spawn-async, bounded reads, JSONC edits, owns_paths globs, paths
│   ├── ui-kit/                   shadcn-style components, cn(), disclosure, surface, realtime channel names (no node:)
│   ├── models/                   provider/model catalog lookup (findModel, findModelIn), presets, prices, reasoning map
│   ├── jev/                      Jev client, registry, thresholds, run wrapper, receipts, three generic judgments
│   ├── host-calls/               runOnHost (runCommand with the timeout rules in one place) and the host-job client
│   ├── settings-catalog/         ui-catalog (generated), channels, defaults, provider pool, bookkeeping paths
│   ├── contracts/                the zod schemas several rooms share (task-v2, stage receipt, workflow view, install receipt ...)
│   ├── workflow-engine/          schema, validator, expressions, engine, router, journal and stores, catalog, view; no built-in workflows
│   ├── i18n/                     t(), locale detection, the chrome dictionary and ten partial dictionaries
│   └── council handoff memory-core resilience run-insights thread-observe   (older packages, own READMEs)
└── src/rooms/                    one folder per domain
    └── <room>/
        ├── index.ts              public domain API (what other rooms import)
        ├── server/  index.ts     code that runs on the hub with ServerCore (src/server/* in the old layout)
        ├── ui/      index.ts     React for the page (src/ui/*)
        └── …                     everything else is private to the room
```

Rooms (files, lines of TypeScript; the lines include the index files). There are nine packages new in this layout: kit, ui-kit, models, jev, host-calls, settings-catalog, i18n, contracts, workflow-engine.

| Room | Files | Lines | server / ui | Public faces |
|---|---:|---:|---|---|
| `anamnesis` | 30 | 3602 | 0 / 2 | domain, ui |
| `contracts` | 9 | 1521 | 0 / 0 | domain (index.ts assembles `hostContract` and `rpcContract` from `host` and seven `rpc-*` parts; the schemas are `@lane-pilot/contracts`) |
| `core` | 17 | 1654 | 17 / 0 | server (ServerCore, Services, RPC aggregator, schedules, thread keys) |
| `council` | 4 | 661 | 2 / 2 | server, ui |
| `critique` | 17 | 2330 | 3 / 2 | domain, server, ui |
| `docs` | 10 | 1691 | 3 / 2 | domain, server, ui |
| `host-worker` | 4 | 1040 | 0 / 0 | domain (host handlers, jobs, script runner) |
| `learning` | 21 | 2103 | 0 / 0 | domain |
| `memory` | 9 | 601 | 5 / 2 | domain, server, ui |
| `native-agent` | 38 | 4891 | 7 / 9 | domain, server, ui |
| `native-install` | 25 | 6250 | 2 / 0 | domain, server |
| `night` | 6 | 516 | 2 / 0 | domain, server |
| `project-life` | 6 | 663 | 3 / 0 | domain, server |
| `qa` | 8 | 1151 | 5 / 0 | domain, server |
| `relay` | 10 | 1030 | 5 / 2 | domain, server, ui |
| `runs` | 27 | 2513 | 12 / 7 | domain, server, ui |
| `schedule` | 30 | 3151 | 9 / 11 | domain, server, ui |
| `secrets` | 3 | 176 | 3 / 0 | server |
| `self-repair` | 7 | 1862 | 5 / 2 | server, ui |
| `settings` | 15 | 2434 | 4 / 6 | domain, server, ui |
| `stability` | 12 | 1296 | 9 / 0 | domain, server |
| `storage` | 2 | 1397 | 0 / 0 | domain (database.ts; the workflow stores are in `@lane-pilot/workflow-engine`) |
| `tasks` | 13 | 924 | 4 / 0 | domain, server |
| `tools` | 6 | 1125 | 5 / 0 | server |
| `ui-shell` | 19 | 2385 | 0 / 19 | ui (page, tabs, project header and rail) |
| `usage` | 6 | 1021 | 4 / 2 | server, ui |
| `verification` | 22 | 3685 | 6 / 0 | domain, server |
| `workflow` | 50 | 7923 | 22 / 23 | domain, server, ui (the engine itself is `@lane-pilot/workflow-engine`) |
| `writer` | 33 | 6138 | 17 / 2 | domain, server, ui |

`scripts/refactor/rooms.ts` is the table that says which file is in which room; `rooms-plan.ts` reports what is unmapped.
The move steps are in `scripts/refactor/steps/*.json` and were applied with `scripts/refactor/move.ts` (git mv plus every import rewritten with
the TypeScript API); `barrels.ts` wrote the index files from the imports that existed; `graph.ts` is the import graph both the codemod and the test use.

## Dependency rules (checked by `tests/architecture/boundaries.test.ts`, which `npx vitest run` and the deploy gate run)

```text
server.ts  host.ts  app.tsx
        ↓ index files of rooms
   src/rooms/<room>/{index.ts, server/index.ts, ui/index.ts}   a room imports another room only through these
        ↓
   packages/*  ◄── a package never imports src/; packages depend downward only (PACKAGE_DEPENDENCIES in the test)
        ↓
   @get-bb/plugin-sdk types, zod, node:*
```

- No value-level import cycle anywhere (type-only imports do not count).
- `ui/` never imports `server/` and the other way round; the UI bundle (everything `app.tsx` reaches) imports no `node:` module.
- Another room is entered through its index files. 77 imports still reach into private files; they are counted per room pair in `tests/architecture/deep-imports.json`,
  the count may only go down (`UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` writes the new numbers after you removed some).
- A `.ts` file does not import a `ui/index.ts` (a model file must not load every component).
- `src/rooms/package.json` says `sideEffects` is limited to the listed files, so a re-export nobody uses is not bundled (without it the host bundle grew by 49 %).
  A file that does something when imported (registers a Jev judgment, hooks `globalThis`) must be listed there; the test finds it if it is not. Such a file is imported
  where it is needed, never through an index file.
- `npm run check:deps` prints the same rules as a dependency-cruiser report (not a dependency of the project; fetched by npx).

## Open

- `rpcContract` and `hostContract` stay in the `contracts` room, not in `@lane-pilot/contracts`: they assemble the schedule and anamnesis fragments that live in their rooms. The schedule and anamnesis schemas would have to move into `@lane-pilot/contracts` first.
- The built-in workflows (`workflows/*.json`) are listed in `src/rooms/workflow/builtin.ts` and handed to `createWorkflowCatalog`; the engine package has no repository-root data.
- The tests are still in `tests/` (vitest also looks in `src/rooms/**/tests`); only the tests of the packages moved with them.
- `src/rooms/storage/database.ts` (1 300 lines, 78 functions) is not split into per-room stores yet; `core/server/services.ts` still names every module's type (51-file type cycle).

## Storage rule

> [!IMPORTANT]
> Memory and learning live in one place: the plugin SQLite on the hub, next to runs and receipts.
> Files under `.agents/memory` on project machines are an **export** for CLI mode, never a second
> source of truth. agentmemory receives an export through the `export` audience when enabled.

## Phases

| Phase | What | Verification | Status |
|---|---|---|---|
| 0 | This map; baseline of tests, typecheck, build on `main` | `npm run check` numbers recorded below | done |
| 1 | `packages/` workspace; thread observation and memory logic moved out of `server.ts` and `src/stages/memory.ts` without behaviour change | failing set identical to baseline, 710 passed, build passes | done (649b439) |
| 2 | New capabilities as packages with thin server wiring: handoff, lessons, routing statistics, golden checks; provider breaker and run budgets as a package | 35 package and server tests; breaker and budget wiring waits for phase 3 because it sits in `spawnWriterAttempt` | done except wiring of resilience |
| 3 | Split `server.ts` into `src/server/*` on one core and one services bag | `server.ts` is 50 lines; failing set identical to the main baseline; build passes | done |
| 3b | `writer-run.ts` split into `writer/{state,spawn,verify,finish,start,dispatch}`; `rpc.ts` into `rpc/{preferences,runs,settings,selections,stack,insights}`; `@lane-pilot/resilience` guards every writer attempt (breaker before spawn, budget per run) | same check plus `tests/server/resilience-wiring.test.ts` | done |
| 4 | One memory: lane-memory files import into the hub corpus and export back (`memory-sync.ts`); routing hint on the settings screen (`get_routing_hint`) | `tests/server/memory-sync.test.ts`, `insights-tools.test.ts` | done |
| 5 | Council of directors (0.1.27) and the boardroom (0.1.28: room protocol with impulse and floor, Jev judge through `councilJudge`, owner messages, presence, a sidebar page; 0.1.29: per-seat provider/model settings, Markdown feed): `@lane-pilot/council` (roles, prompts, moderator rule, protocol, storage, decision page) and `src/server/council.ts` (seats on hidden threads with distinct configured models, evidence pack from PROJECT.md, docs and materials, decision page under `docs/decisions/`, next tasks as handoffs, feed in the run monitor) | `packages/council/tests`, `tests/server/council-tools.test.ts` | done |

## Baseline on main (08d907a, 2026-09-30)

Recorded by phase 0 in the `arch/foundation` worktree, before any move.

<!-- baseline:start -->
| Check | Result on main |
|---|---|
| `vitest run` | 807 tests: 710 passed, 95 failed, 2 skipped, 2 file errors |
| `tsc --noEmit` | 5 errors: `server.ts` (two), `src/agent-inventory.ts`, two test files |
| `bb plugin build` | passes |

Failing files before any move: `tests/stages/server-stage.test.ts` (79), `tests/writer-validate.test.ts` (9),
`tests/ui-runtime.test.ts` (2), one each in `acceptance-v2`, `external-skip`, `guard`, `pipeline`,
`server-reconcile`, `workspace/routing`. Three of them read fixtures from another chat's `.bb/chats/*/tmp`
checkout of claude-lane-stack, which exists only in the main checkout; the rest are the pre-existing
BB-kind writer harness failures noted on 2026-09-30.
<!-- baseline:end -->

## Rules

1. New server-side behaviour goes into the `server/` folder of a room or into a package, never into the body of `plugin()` in `server.ts`.
2. Touching an old closure in `server.ts` means moving it out first, then changing it.
3. A package gets a `README.md` with its contract and one sentence on who else may use it.
4. Every move is a separate commit with tests green; moves and behaviour changes are never mixed.
5. Another room is imported through its index files; a name other rooms need is added to the `index.ts` of the face it lives in (see Layout).

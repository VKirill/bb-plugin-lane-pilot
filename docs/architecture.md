---
title: Lane Pilot architecture and the road to it
status: active
owner: AG-190 Lane Pilot
started: 2026-09-30
---

# Lane Pilot architecture

> [!NOTE]
> This page is the map. It says where code lives, what may depend on what, and in which order the
> plugin is being moved from one 7 000-line `server.ts` into modules and reusable packages.
> The rules in [Rules](#rules) apply to every change from 2026-09-30 on.

## Target layout

```text
bb-plugin-lane-pilot/
├── server.ts                 entry only: open storage, build the context, mount modules
├── host.ts                   host worker entry (unchanged)
├── app.tsx                   UI entry (unchanged)
├── packages/                 reusable, plugin-agnostic; depend on SDK types + zod only
│   ├── resilience/           stream retry, provider circuit breaker, run budgets
│   ├── thread-observe/       bounded thread event listing, idle wait, child observation
│   ├── memory-core/          memory records, guards, budgets, retrieval, lessons, golden evals
│   ├── handoff/              task cards between agents, receipts, capability registry, leases
│   └── stage-kit/            stage receipt contract, child snapshot parsing, stage harness
└── src/
    ├── server/               plugin modules mounted on one context (phase 3)
    │   ├── context.ts        db, bb, settings access, logging, disposed flag
    │   ├── activation.ts     PM activation and finish
    │   ├── writer-run.ts     dispatch, spawn, validate, accept, finish an attempt
    │   ├── reconcile.ts      orphan and holder-thread recovery
    │   ├── stages/           one file per StageId that needs server wiring
    │   ├── docs-nightly.ts   nightly docs pass and catch-ups
    │   ├── rpc/              RPC handlers grouped: settings, selections, runs, stack
    │   ├── tools.ts          agent tool registration
    │   └── cli.ts            bb lane-pilot commands
    ├── stages/               stage logic: prompts, parsers, policies (no SDK calls)
    ├── host/                 host worker: detect, install, snapshot, rollback, stack ops
    ├── ui/                   settings and monitor surfaces
    ├── verification/         sandbox, git ownership, docs checks
    └── workspace/            routing and dirt detection
```

## Dependency rule

```text
app.tsx / host.ts / server.ts
        ↓
   src/server/* ──► src/stages, src/host, src/verification, src/workspace
        ↓                          ↓
   packages/*  ◄───────────────────┘
        ↓
   @get-bb/plugin-sdk types, zod, node:*
```

- A package never imports from `src/`. It ships its own tests under `packages/<name>/tests`.
- `src/stages` holds pure logic: prompts, parsers, decisions. It never calls the SDK.
- Only `src/server/*` calls `bb.sdk`, `bb.rpc`, `bb.agents`, `bb.cli`.
- Packages are npm workspaces inside this repository, imported as `@lane-pilot/<name>`.
  They are not published yet; another plugin can consume them by path until they are.

## Storage rule

> [!IMPORTANT]
> Memory and learning live in one place: the plugin SQLite on the hub, next to runs and receipts.
> Files under `.agents/memory` on project machines are an **export** for CLI mode, never a second
> source of truth. agentmemory receives an export through the `export` audience when enabled.

## Phases

| Phase | What | Verification | Status |
|---|---|---|---|
| 0 | This map; baseline of tests, typecheck, build on `main` | `npm run check` numbers recorded below | done |
| 1 | `packages/` workspace; move stream retry, thread observation, memory logic out of `server.ts` and `src/stages/memory.ts` without behaviour change | same test count green, `bb plugin build` bundles | in progress |
| 2 | New capabilities as packages with thin server wiring: handoff, lessons, routing statistics, provider breaker and run budgets | package tests plus one server stage test each | planned |
| 3 | Split `server.ts` into `src/server/*` on the context object | `server.ts` under 300 lines, all tests green | after the parallel-lanes work on `main` is committed |
| 4 | Council stage on the handoff and thread-observe packages | staged test with three seats | planned |

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

1. New server-side behaviour goes into a module under `src/server/` or a package, never into the body of `plugin()` in `server.ts`.
2. Touching an old closure in `server.ts` means moving it out first, then changing it.
3. A package gets a `README.md` with its contract and one sentence on who else may use it.
4. Every move is a separate commit with tests green; moves and behaviour changes are never mixed.

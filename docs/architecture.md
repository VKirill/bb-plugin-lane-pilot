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
│   ├── thread-observe/       bounded thread event listing, idle wait, child observation
│   ├── memory-core/          memory records, guards, budgets, retrieval over SQLite
│   ├── handoff/              task cards between agents, receipts, capability registry, leases
│   ├── resilience/           provider circuit breaker, run budgets (stream retry joins after merge)
│   ├── run-insights/         writer statistics per model and risk, lessons from receipts, golden checks
│   ├── council/              council of directors: roles, prompts, moderator, protocol, storage, decision page
│   └── stage-kit/            stage receipt contract, child snapshot parsing, stage harness (planned)
└── src/
    ├── server/               plugin modules on one core and one services bag
    │   ├── core.ts           bb, db, host client, native installer, shared helpers (settings, sections, run scopes)
    │   ├── services.ts       the interface of everything one module offers another
    │   ├── native-wiring.ts  mention provider, native dispatch hook, provider env, stream retry
    │   ├── reconcile.ts      orphan and holder-thread recovery
    │   ├── activation.ts     PM activation and composer environment checks
    │   ├── writer/           state (task set, pool, breaker, budgets), spawn, verify, finish, start, dispatch
    │   ├── writer-host.ts    project writer host resolution and agent profiles
    │   ├── stages/           qa, children, docs, onboarding, memory, project-life, night
    │   ├── docs-nightly.ts   nightly docs pass, units, catch-ups and their schedules
    │   ├── probes.ts         live probes for cancel, provider error and ambiguity
    │   ├── critique-runs.ts  pm-read, plan critique, code critique, specialist review
    │   ├── run-routing.ts    helper placement, run routing, native setting keys
    │   ├── run-finish.ts     finish and cancel rules
    │   ├── writer-task.ts    writer prompt and fixture task
    │   ├── child-snapshots.ts, stage-records.ts, values.ts, pm-spawn.ts
    │   ├── handoff.ts        handoff tools and expiry schedule
    │   ├── insights.ts       routing statistics, lessons sweep, golden checks
    │   ├── rpc.ts, rpc/      RPC handlers by group: preferences, runs, settings, selections, stack, insights
    │   ├── memory-sync.ts    lane-memory files ↔ the hub corpus
    │   ├── health.ts         provider breaker and run budget for the PM and the CLI
    │   ├── council.ts        council sessions on hidden seat threads: room or rounds, Jev judge, owner messages, presence, decision page, handoffs, RPC
    │   ├── tools.ts          agent tool registration and PM configuration
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
   (modules receive `ctx: ServerCore` and `services: Services`; cross-module calls go through `services`, read at call time)
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

1. New server-side behaviour goes into a module under `src/server/` or a package, never into the body of `plugin()` in `server.ts`.
2. Touching an old closure in `server.ts` means moving it out first, then changing it.
3. A package gets a `README.md` with its contract and one sentence on who else may use it.
4. Every move is a separate commit with tests green; moves and behaviour changes are never mixed.

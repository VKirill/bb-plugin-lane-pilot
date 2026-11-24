---
name: "Lane Pilot: pause, prune, one scheduler, one architecture"
overview: "Keep the plugin off while the experiments are removed, every periodic job becomes a graph on the schedule board, and the surviving rooms follow .ai-factory/ARCHITECTURE.md."
status: proposed
created: 2026-11-24
todos:
  - id: step-1-pause-the-pilot
    content: "Pause every open run and disable the plugin on the hub so nothing runs or rewrites files"
    status: completed
  - id: step-2-freeze-record-and-resume-runbook
    content: "Record the pause and the exact way back in a decision record"
    status: pending
  - id: step-3-owner-keep-list
    content: "Owner approves the keep/delete list for 58 schedules, 3 services, 81 rooms and 130 graphs"
    status: pending
  - id: step-4-delete-experiment-clusters
    content: "Delete the approved experiment rooms, their schedules, graphs, settings, i18n keys and tests, one cluster per commit"
    status: pending
  - id: step-5-one-scheduler
    content: "Move every surviving periodic job onto the schedule board as a graph and guard that no other timer appears"
    status: pending
  - id: step-6-board-wide-pause
    content: "Add one board-wide pause switch so the next pause needs no plugin disable"
    status: pending
  - id: step-7-room-layout-alignment
    content: "Bring the surviving rooms to the ARCHITECTURE.md layout and ratchet it with a layout guard"
    status: pending
  - id: step-8-evolution-graph-design
    content: "Design the single self-evolution graph with the owner before any of it is built"
    status: pending
  - id: step-9-release-and-reenable
    content: "Release through the deploy script, enable the plugin, resume runs one by one, verify the schedule list"
    status: pending
isProject: true
---

# Implementation Plan: Lane Pilot — pause, prune, one scheduler, one architecture

## Кратко для владельца (RU)

- **Пилот уже выключен** (24.11, 17:24 UTC): 8 открытых прогонов поставлены на паузу, плагин отключён на хабе. Ни одно из 58 расписаний и 3 сервисов не работает, документацию никто не переписывает. Вернуть: `bb plugin enable lane-pilot` (шаг 9 описывает, как делать это безопасно).
- **Дальше по порядку:** вы утверждаете список «оставить / удалить» (шаг 3, черновик ниже) → удаляем эксперименты кусками → всё, что осталось периодическим, становится графом на доске расписаний → оставшиеся комнаты приводим к `ARCHITECTURE.md` → проектируем один граф самоэволюции → релиз и включение.
- **Черновик сокращения:** из 58 расписаний остаются около 22 (ход задач), удаляются около 30 (ночные эксперименты, экзамены, docs-night), около 6 решаете вы. Это примерно 50 тыс. строк из 204 тыс. в `src/rooms`.
- **Что пропадает на время паузы:** `bb lane-pilot memory`, PM-чаты пилота, страницы пилота в BB. Работа идёт в обычных чатах.

```
 today                                   target
 ─────                                   ──────
 58 scheduleIsolated timers  ──prune──▶  ~22 jobs ──▶ schedule board rows ──▶ graphs (workflows/lp.*.json)
 + 3 services                            1 timer: schedule-board-tick (+ board-wide pause)
 81 rooms, flat files        ──prune──▶  ~60 rooms ──▶ index.ts · models/ · server/{handlers,services,repositories} · ui/
 night experiments (bench, wall, lead exams, rules, lessons, learning, graph-evolve, docs-night …)
                             ──delete──▶  one evolution graph lp.evolve (owner-designed, step 8)
```

## Investigation Results

> Serena and sequential-thinking are not connected in this environment; the facts below come from grep over the checkout, the live hub (`bb plugin list`, `bb lane-pilot state`) and the architecture baselines.

### Symbols found

**Timers (one choke point)**
- `src/rooms/platform/server/schedules.ts:43` — `scheduleIsolated(bb, name, cron, work, options)`: every Lane Pilot timer goes through it (VK isolated schedule, or `bb.background.schedule` fallback at `:52`). 66 call sites in `src/`, `server.ts`.
- `server.ts:496-693` — the core run timers: `landing-suite` `:496`, `attempt-worktree-sweep` `:576`, `task-reconcile` `:583`, `writer-silence-sweep` `:606`, `writer-question-sweep` `:609`, `writer-wake` `:612`, `stability-drill` `:616`, `workflow-schedules` `:685`, `runs-sweep` `:686`, `ship-watch` `:689`, `schedule-board-tick` `:693`.
- `src/rooms/docs/server/docs-schedules.ts:39-45` — `registerDocsSchedules()`: `docs-maintenance-hourly`, `docs-nightly-hourly`, `docs-nightly-catchup` (every 2 min) — the jobs that rewrite documentation.
- Experiment timers: `bench/server/weekly.ts:27,120,165`, `bench/server/service-pin.ts:54`, `wall/server/wall.ts:342-353`, `improvement/server/rpc.ts:19`, `lead/server/service.ts:405-408`, `learning/service.ts:323-324`, `self-repair/server/self-repair.ts:262`, `self-repair/server/insights.ts:338`, `self-repair/server/rule-scan.ts:592,610`, `rule-forms/promotion-service.ts:128`, `baseline/server/regress.ts:396`, `harness/server/harness.ts:32`, `pm-replay/service.ts:268`, `night-graphs/server/graph-evolve-graph.ts:471`, `night-graphs/server/episodes-graph.ts:115`, `night-graphs/server/critic-edit-graph.ts:67`, `tools/server/tools.ts:148`, `anamnesis/wiring.ts:154`.

**The target already exists, half-used**
- `src/rooms/schedule/server/system-schedules.ts:19` — `SYSTEM_SCHEDULES`: Lane Pilot's own jobs as schedule-board rows that run a graph, visible and pausable. Only 2 jobs use it (worktree cleanup → `workflows/lp.worktree-cleanup.json`).
- `src/rooms/schedule/scheduler.ts:276` — `tick(options)`: turns due rows into runs; the one place a board-wide pause belongs.
- `bb lane-pilot pause <run-id>` / `schedule pause <id>` — per-run and per-row pause exist; there is no global one.

**Live hub (before the pause)**
- `bb plugin list`: `lane-pilot@0.1.609 running`, 58 schedules, 3 services (`world-tick`, `relay-sweep`, `startup-recovery`).
- Open runs across 25 projects: 3 running, 5 blocked (all paused in step 1).

**Architecture baselines** (`tests/architecture/`)
- `deep-imports.json` — 159 room pairs with deep imports.
- `foreign-sql-baseline.json` — 8 foreign SQL sites.
- `file-size.json` — 42 files over the 500-line limit.
- `room-graph-baseline.json` — 81 rooms, 659 edges, largest SCC 1, 0 mutual pairs (the untangle work, `.agents/plans/untangle/decision-log.md`, already fixed the direction).
- 0 rooms have `models/`; 11 rooms have no `index.ts`.

### Draft keep/delete list (owner decides in step 3)

| Group | Schedules / services | Rooms (lines) | Draft |
|---|---|---|---|
| Task flow | writer-wake, writer-silence-sweep, writer-question-sweep, task-reconcile, attempt-worktree-sweep, permit-sweep, phase-drive, runs-sweep, run-goal-sweep, landing-suite, handoff-expiry, schedule-board-tick, workflow-schedules; services relay-sweep, startup-recovery | writer, runs, phase, run-goal, rollback, relay, schedule, workflow | **Keep** |
| Owner signal | outage-beat, owner-bell, owner-push, daily-report, canary-check | outage, owner-waiting, reports, stability | **Keep** |
| Memory | memory-embed, memory-dedupe | memory | **Keep** (owner uses hub memory) |
| Accounting | token-usage-sync, usage-snapshot-push | usage | **Decide** |
| Docs night | docs-maintenance-hourly, docs-nightly-hourly, docs-nightly-catchup | docs (3476, night part) | **Delete** the night part |
| Bench | bench-nightly, bench-weekly, bench-sweep, bench-service-models | bench (3293) | **Delete** |
| Wall / improvement | wall-night, wall-advance, policy-exam-collect | wall (3297), improvement (511) | **Delete** |
| Lead exams | lead-sweep, lead-exam, lead-labels, lead-memory-exam | lead (2744) | **Delete** |
| Learning / rules / lessons | learning-extract, learning-digest, lessons-sweep, rules-nightly, rules-triage, rule-promotions-weekly, self-repair | learning (1772), self-repair (3153), rule-forms (682) | **Delete** (self-repair is already OFF by owner) |
| Night graphs | graph-evolve-nightly, episodes-hourly, critic-edit-monthly | night-graphs (4982), night (187) | **Delete** → replaced by step 8 |
| Regression / harness / replay | regress-nightly, harness-nightly, pm-replay-nightly, curriculum-weekly | baseline (1559), harness (1939), pm-replay (778), tools curriculum part | **Delete** |
| Meta-proof | — (used by `lp-ship.ts` gate, `scripts/sma-*`) | sma-map (16045) | **Decide** (draft: delete with its gate hooks) |
| Owner profile | anamnesis-daily | anamnesis (4808) | **Decide** |
| World | service world-tick | world (590), packages world-sim (1916), pixel-world (1454) | **Decide** (draft: delete) |
| Misc | capability-sweep, profile-check-daily, service-projects, ship-watch, stability-drill, backlog-scan, front-peers | capability, native-agent, stability, backlog, front | **Decide** one by one |
| Eval rooms | — | memory-eval (2105), memory-probe (242), design-eval (533), coverage (337), hypotheses (167), forge (340) | **Delete** |

### Existing patterns (follow them)
1. A periodic job as a graph on the board: `system-schedules.ts:19` + `workflows/lp.worktree-cleanup.json`, starter guard `systemStarterOf()` (`system-schedules.ts:40`).
2. Room public API and wiring: `src/rooms/backlog/index.ts`, `src/rooms/backlog/server/index.ts`, mounted from `server.ts` through `Services`.
3. Ratchet tests that may only shrink: `tests/architecture/boundaries.test.ts` + `deep-imports.json`, lowered with `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture`.
4. Generated docs follow code: `npx tsx scripts/generate-atlas.ts` after removing a room, command, graph or RPC method (the atlas test fails otherwise).

### Dependencies
- Internal: `@lane-pilot/workflow-engine`, `@lane-pilot/settings-catalog`, `@lane-pilot/i18n`, `@lane-pilot/contracts`, `src/rooms/migrations.ts` (append-only).
- External: `@get-bb/plugin-sdk` (`bb.background`, `experimental_vkSchedule`), `better-sqlite3`, Vitest.

## Approach Selection

| Approach | Pros | Cons | Complexity |
|----------|------|------|------------|
| **A: Prune first, then unify, then align** | No work spent restructuring code that is deleted; each wave shrinks the baselines; the plugin can stay off the whole time | Needs the owner's keep list before code moves | Med |
| **B: Align every room in place, prune later** | Uniform code early | Restructures ~50k lines that will be deleted; huge diff; long pause | High |
| **C: Rewrite the core as a fresh graph engine, port what is needed** | Clean slate | Loses battle-tested run machinery (attempt ledger, merge queue, recovery); longest pause; highest risk | High |

- **Selected:** Approach A.
- **Reasoning:** the deletion list removes about a quarter of the room code and most of the schedules; aligning only what survives is the shortest correct path. The schedule board already runs jobs as graphs, so unification extends an existing pattern instead of inventing one.
- **Trade-offs:** the owner must decide the "Decide" rows before step 4; the plugin stays off until step 9.
- **Branching evidence:** compared without the sequential-thinking MCP (not connected); branches A/B/C weighed against the measured sizes above.

## Implementation Steps

### Step 1. Pause the pilot — done 2026-11-24 17:24 UTC
**Files**: none (operation on the hub).
**What**: `bb lane-pilot pause` for the 8 open runs (3 running, 5 blocked), then `bb plugin disable lane-pilot`. Verified: `lane-pilot … disabled`; `bb lane-pilot` answers «plugin is disabled».
**Where**: hub `bb` server.
**Pattern**: run pause semantics of `bb lane-pilot pause` (new tasks wait, nothing canceled).
**Key signatures**: `bb plugin enable lane-pilot` — the only way back.
**Logging**: info — the run ids paused and the disable time go into the step 2 record.

### Step 2. Freeze record and resume runbook
**Files**: `docs/decisions/2026-11-24-pilot-pause.md` (create).
**What**: why the pilot is off, the 8 paused run ids per project, what is unavailable (memory CLI, PM chats, UI), the exact resume order (step 9), and that nobody enables the plugin before step 9.
**Where**: `docs/decisions/`, next to `2026-10-08-lane-pilot-data-db-access.md`.
**Pattern**: existing decision records in `docs/decisions/`.
**Key signatures**: none.
**Logging**: none (document).

### Step 3. Owner keep list
**Files**: this plan, table «Draft keep/delete list» (modify).
**What**: the owner marks every «Decide» row Keep or Delete and confirms the «Delete» rows. The result is the only list steps 4–5 act on.
**Where**: section «Investigation Results» above.
**Pattern**: owner-yes gate, as in `.agents/plans/2026-11-02-graph-library-self-growth.md` (law 8).
**Key signatures**: none.
**Logging**: none.

### Step 4. Delete experiment clusters (one commit per row)
**Files**: `src/rooms/<room>/` for each approved row (delete); `server.ts` (modify: mounts, `Services` fields); `src/rooms/contracts/rpc-*.ts` (modify: removed RPC methods); `packages/settings-catalog/src/*` (modify: removed setting keys); `packages/i18n/src/*` (modify: removed keys); `workflows/lp.*.json` of the cluster (delete); `tests/*` of the cluster (delete); `tests/architecture/*.json` (modify: baselines go down); `docs/atlas.md`, `docs/map/` (regenerated); guide pages that describe the cluster (modify).
**What**: remove the room, every registration of it (schedules, tools, CLI verbs, RPC, settings, i18n, graphs) and its tests; keep its tables (migrations are append-only, data stays readable); regenerate the atlas; lower the baselines. Start with docs-night so documentation stops changing.
**Where**: one cluster per branch/worktree, merged after `npm run check`.
**Pattern**: removal of a room's wiring mirrors its mount in `server.ts:465-693`; search by room name and by every exported symbol before deleting (string and dynamic use included).
**Key signatures**: none new.
**Logging**: no new log lines; delete the cluster's `bb.log.*` lines with it.

### Step 5. One scheduler: every surviving job is a graph on the board
**Files**: `src/rooms/schedule/server/system-schedules.ts` (modify); `workflows/lp.<job>.json` per surviving job (create); `server.ts` and the owning rooms' `server/index.ts` (modify: drop the `scheduleIsolated` calls); `tests/architecture/schedule-home.test.ts` (create).
**What**: each kept job from step 3 becomes a `SYSTEM_SCHEDULES` entry whose task is a graph with a code step calling the room's existing service; the raw timer is removed. The new guard test fails when `scheduleIsolated(` appears outside `src/rooms/schedule/` (allowed: `schedule-board-tick`, plus any job the owner keeps sub-minute).
**Where**: `SYSTEM_SCHEDULES` array at `system-schedules.ts:19`.
**Pattern**: `worktree-cleanup-hourly` entry (`system-schedules.ts:20-25`) and `workflows/lp.worktree-cleanup.json`.
**Key signatures**:
- `SystemSchedule { key, starter, definition }` — existing type, one entry per job.
**Logging**: info — the board logs each run start/finish (existing); warn — a job whose graph fails `maxFailures` times (existing board behaviour); error — none new.

### Step 6. Board-wide pause
**Files**: `src/rooms/schedule/scheduler.ts` (modify); `packages/settings-catalog/src/*` (modify: one key); `src/rooms/schedule/server/schedule-cli.ts` (modify).
**What**: one global setting (e.g. `schedule.paused_all`) checked at the start of `tick()`; while set, no row starts and the board shows why. CLI: `bb lane-pilot schedule pause-all [reason]` / `resume-all`. Next time the pilot can be quieted without disabling the plugin (memory and UI stay up).
**Where**: top of `tick()` at `scheduler.ts:276`.
**Pattern**: per-row pause in `src/rooms/schedule/store.ts:31-32` (`state = paused`, `pause_reason`).
**Key signatures**:
- `isBoardPaused(settings): { paused: boolean; reason?: string }` — read once per tick.
**Logging**: info — `schedule board paused: <reason>` once on change, not every tick; warn — unreadable setting counts as not paused, logged once.

### Step 7. Room layout alignment
**Files**: each surviving room (modify/move into `models/`, `server/handlers/`, `server/services/`, `server/repositories/`, `ui/`); the 11 rooms without `index.ts` (create `index.ts`); `tests/architecture/room-layout.test.ts` (create); `tests/architecture/deep-imports.json`, `foreign-sql-baseline.json`, `file-size.json` (modify: down).
**What**: per room, in order of churn (writer, runs, workflow, contracts, storage first): move pure rules to `models/`, SQL to `repositories/`, orchestration to `services/`, RPC/tool/CLI/schedule entry points to `handlers/`; replace deep imports with public exports; move foreign SQL behind the owning room's API. The layout guard lists legacy rooms in a baseline that may only shrink, and new rooms must have the layout.
**Where**: room by room; one room per commit.
**Pattern**: `.ai-factory/ARCHITECTURE.md` code examples; the file split plan `.agents/plans/2026-11-01-refactor-split-plan.md` for `writer/server/start.ts`, `storage/database.ts`, `writer/server/finish.ts`.
**Key signatures**: none new (moves only, behaviour unchanged).
**Logging**: unchanged; log lines move with their code.

### Step 8. Self-evolution graph — design with the owner first
**Files**: `docs/decisions/2026-11-2x-evolution-graph.md` (create).
**What**: one graph `lp.evolve` replaces wall-night, rules, lessons, learning, graph-evolve and the exams: what signal it reads (failed attempts, repeated errands), what it may change (graphs only, through drafts), and the owner-yes gate before any change goes live. Built only after the owner approves the record; building it is a separate plan.
**Where**: `docs/decisions/`.
**Pattern**: `docs/workflows-evolution.md` and `.agents/plans/2026-11-02-graph-library-self-growth.md` (what to keep from them).
**Key signatures**: none (design).
**Logging**: none (document).

### Step 9. Release and re-enable
**Files**: `package.json` (modify: version); `CHANGELOG.md` (modify).
**What**: release through the deploy script (ends with the drill that rolls back on red), `bb plugin enable lane-pilot`, check `bb plugin list` shows exactly the approved schedule list, then `bb lane-pilot resume <run-id>` one run at a time, watching each.
**Where**: hub.
**Pattern**: `docs/deployment.md`, `scripts/lp-ship.ts gate`.
**Key signatures**: none.
**Logging**: info — the startup line `Lane Pilot PM-to-writer pipeline loaded` (`server.ts:695`); warn/error — startup-recovery findings for the resumed runs.

## Files Summary

**New** (6): `docs/decisions/2026-11-24-pilot-pause.md` — pause record; `tests/architecture/schedule-home.test.ts` — no timers outside the board; `tests/architecture/room-layout.test.ts` — layout ratchet; `docs/decisions/2026-11-2x-evolution-graph.md` — evolution design; `workflows/lp.<job>.json` — one per surviving job (counted as one group); `src/rooms/<room>/index.ts` — for the 11 rooms without one (counted as one group).

**Modified** (13): `server.ts`; `src/rooms/schedule/server/system-schedules.ts`; `src/rooms/schedule/scheduler.ts`; `src/rooms/schedule/server/schedule-cli.ts`; `src/rooms/contracts/rpc-*.ts`; `packages/settings-catalog/src/*`; `packages/i18n/src/*`; `tests/architecture/deep-imports.json`; `tests/architecture/foreign-sql-baseline.json`; `tests/architecture/file-size.json`; `docs/atlas.md` + `docs/map/` (generated); `package.json`; `CHANGELOG.md`.

**Deleted** (approved in step 3): up to 22 room directories, their `workflows/lp.*.json`, tests and the `world-sim` / `pixel-world` packages if «World» is deleted.

**Total**: 6 + 13 = 19 file groups changed, plus the deleted directories.

## Risks & Rollback

| Risk | Impact | Mitigation |
|------|--------|------------|
| Something enables the plugin before step 9 | H | Decision record (step 2); only the owner enables |
| Hub memory (`bb lane-pilot memory`) unavailable during the pause | M | Agents read code and docs; facts to remember go into the step 2 record and are written to memory after step 9 |
| A deleted room is imported by a kept one (hidden coupling) | M | Search every exported symbol and string id before deleting; `npm run check` + `check:deps` per cluster |
| Removing `sma-map` breaks `lp-ship.ts gate` | H | Decide in step 3; if deleted, the gate's SMA steps go in the same commit |
| Paused runs resume into a changed codebase | M | Resume one by one in step 9; cancel those whose tasks no longer make sense |
| Tables of deleted rooms remain | L | Intentional (append-only); a later appended migration may drop them with the owner's yes |

**Rollback**: the pause — `bb plugin enable lane-pilot` and `bb lane-pilot resume <run-id>`. Code waves — each cluster is one commit: `git revert <sha>`; a release — the deploy script's drill rolls back on red.

## Execution Pipeline

| Order | Who | Responsibility | Skills/Tools |
|-------|-----|----------------|--------------|
| 1 | this chat | Pause (done), decision record | bash, bb CLI |
| 2 | owner | Keep/delete list (step 3) | — |
| 3 | parallel agent chats, one worktree per cluster | Deletion waves (step 4) | @git-worktree, /aif-implement |
| 4 | main agent | One scheduler + board pause (steps 5–6) | /aif-implement |
| 5 | parallel agent chats, one room per worktree | Layout alignment (step 7) | /aif-implement |
| 6 | owner + main agent | Evolution design (step 8) | /aif-explore |
| 7 | /verifier | `npm run check`, `npm run check:deps`, atlas test | /aif-verify |
| 8 | **/reviewer** | **Review each wave (mandatory)** | /aif-review |
| 9 | main agent | Release and re-enable (step 9) | deploy script, `lp-ship.ts gate` |

**Review**: after each wave `/aif-verify` → `/aif-review` (Critical / Major / Minor), at most 2 iterations; check that the wave removed or changed only what its row allows.

## Validation

**Coverage of the request**
- [x] Pilot fully paused, nothing runs or rewrites docs (step 1)
- [ ] Unneeded schedules and rooms removed (steps 3–4)
- [ ] One graph system: every periodic job is a graph on the board (step 5)
- [ ] One architecture for all remaining code (step 7)
- [ ] Self-evolution as one graph, owner-designed (step 8)

**Project checks** (per wave)
- [ ] `npm run check` (tests, typecheck, build, layout) green
- [ ] `npm run check:deps` clean
- [ ] Baselines only went down
- [ ] `npx tsx scripts/generate-atlas.ts` run, atlas test green

**Logging**
- [ ] Every step lists its logging; removed rooms take their log lines with them

**Code review**
- [ ] `/aif-review` after each wave; Critical/Major fixed

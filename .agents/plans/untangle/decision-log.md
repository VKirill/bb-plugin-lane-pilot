# Untangle decision log — Lane Pilot plugin

Started 2026-11-07. Goal: pieces that change together live together, nothing
imports something more volatile than itself, as few special cases as possible.
Owner chose both additions: **Comments** (drop comments that only restate the
code) and **Tests** (drop tests that cannot catch a real bug, fix tests that
fail without one — done last).

Full problem list with file:line evidence: `argon-audit-ru.md` (Argon, verified
by recount on 2026-11-06). Measure progress with `node scripts/room-graph.mjs`.

## Baseline (2026-11-07, main c6b443cb)

| metric | value |
|---|---|
| rooms | 81 |
| largest room SCC | 65 |
| mutual room pairs | 123 |
| room edges | 671 |
| `.catch(() => x)` | 799 |
| empty / comment-only `catch {}` | 168 |
| `db.prepare` | 910 |

Hubs: core (out 54 / in 51), storage (out 27 / in 53), writer (28/26),
contracts (2/50), tools (50/2), runs (17/32).

## Fixes, each above the problems it solves

### F1. Dependency direction: kit/contracts/storage at the bottom, domains in the middle, core/tools/server.ts on top
The one fix behind most of the SCC. Bottom layers never import a domain room;
domains never import `core` or `tools` (the composition root).
- storage/database.ts imports 27 domain rooms; `transitionAttempt` calls memory-core.
- 51 rooms import `core` (Services type, rpc helpers) — the composition root is imported by what it composes.
- `const services = {} as Services` in server.ts:93, filled by mutation; order of `mountLearning`/`mountRegressionTools` before `registerTools` is implicit.
- `Services` is one 135-field bag passed everywhere, carries private room constants (DOCS_NIGHT_ATTEMPTS).
- setting-validation.ts bare side-effect imports to fill the judgment registry.

### F2. One owner per table; cross-room readers go through that owner's read functions
- `lane_pilot_run` touched by 40 rooms, `attempt` 36, `task` 25 (raw `db.prepare`, `json_extract`).
- `listCheckTimeouts` parses `attempt.reason` text with `instr`/regex; run-goal filters on `detail LIKE 'the check failed:%'` → store `failure_code`/`check_name`/`timeout_sec` columns.
- worktree owner guessed from name prefixes (`ownerKindOfName`, core.ts:137).
- KV keys are global string conventions (`host-job:`, `native-selection:`, `native-thread:`).

### F3. One role registry (`RoleSpec`) drives settings RPC, defaults, routing and UI
- selections.ts: the same 25-line validate+`casUpsertSettings` block copied 9 times.
- role lists repeated in settings.ts, run-routing.ts, page-model.ts, role-models.ts, rpc-settings.ts.
- providerId special branches spread over server.ts, database.ts, settings.ts, spawn-model.ts.

### F4. sma-map and tests depend on exported symbols, not source text
- sma-map/model.ts verifies 1 798 `path#substring` pairs with `readFileSync().includes()`; live.ts hardcodes table names.
- 12 test files read `src/rooms/**` as text. Every move/rename breaks them → blocks every other fix.
- boundaries.test.ts checks file cycles only; add a room-level ratchet (SCC and mutual pairs may only go down).

### F5. Attempt lifecycle in one place
- attempt transitions spread over tasks, runs, writer, verification, critique, stability, stage-return, rollback, run-goal, pilot via `reason` prefixes (`WAITING_WRITER_PREFIX`, `REPLAY_CHECK_FAILED`, `thread_status_error:`).
- writer/start.ts 1 469 LOC, writer/finish.ts 1 161, phase/driver.ts 1 240, self-repair.ts 1 309; side effects (learning, memory, metrics, notices) hard-wired in finish.ts.
- docs-*.ts, git-docs.ts and stability-drill.ts live in `verification`.

### F6. Host contract split by domain; no `node -e` string runner
- host-handlers.ts 942 LOC mixes git, TypeSafe/OpenLux HTTP, jev-ultrafast desktop, WireGuard scan, YAML regex edit; contracts/host.ts 76 methods.
- jobs.ts runs a JS string via `node -e`, finds handlers by `.default?.handlers?.[kind]`; busy-wait file lock `setTimeout(100)×20×3`.

### F7. No developer environment in product code
- cli.ts:604 `recover` checks `hello.txt` / `tests/hello.test.txt`.
- self-repair.ts:66 hardcodes projectId, environmentId, sectionId, ignoreProjects, hub ssh.
- employee-place.ts `AFFINITY_HOSTS` host ids; host-handlers.ts:913 `~/Documents/BB-сервис/toolkit/...`; spawn-model.ts macOS `/Users/*/Documents` check for opencode2.

### F8. Errors: expected ones handled by name, unexpected ones logged
- 799 `.catch(() => x)` + 168 empty catch. Each one either names the expected error (ENOENT, gone thread) or logs through `bb.log`.

### F9. Surplus
- dead rooms atlas, twins, guard-tools; dead files listed in argon-audit-ru.md cluster D (install-runner.ts has a type import from stack-ops.ts — move the type, then delete); packages/workflow-engine/src/db.ts; duplicated `compiledMainAgentSpawnBinding` in activation.ts.
- 25+ micro rooms (25–200 LOC) that change with one neighbour → merge into that neighbour (cluster D list).

## Waves and status

| wave | fixes | stream | status |
|---|---|---|---|
| 0 | F7, F9 dead code | U0 | started 2026-11-07 |
| 1 | F4 + room ratchet test | U1 | started 2026-11-07 |
| 1 | F3 | U2 | started 2026-11-07 |
| survey | F1/F2 import map for storage and core | U4 | started 2026-11-07 |
| 3 | F6 host contract split, jobs runner | U5 | started 2026-11-07 |
| 4 | F5 verification moves + F2 structured failure fields | U6 | started 2026-11-07 |
| 2 | F2 typed KV keys, explicit worktree owner | U7 | started 2026-11-07 |
| 4 | F5 phase driver | U8 | started 2026-11-07 |
| 4 | F5 writer start/finish | U9 | started 2026-11-07 |
| 4 | F5 self-repair | U10 | started 2026-11-07 |
| 2 | F1 storage side, F2 table owners | — | from the U4 survey |
| 3 | F1 core side (Services, server.ts order) | — | from the U4 survey |
| 5 | F9 micro rooms, F8, Tests | — | last |

## Merge rules (merger = the orchestrator thread)
- Review each stream by another model family (Grok 4.7 via acp-cursor, Gemini 3.8 Flash
  via opencode2 router9) before merge; full vitest on main after each merge.
- Generated files (README.md, docs/atlas.md, docs/map/index.html) are regenerated once
  per merge, never taken from a stream.
- Owner 2026-11-07: no deploy per wave. All waves merge into main (full vitest after
  each merge); one release at the end, after the final check, then the drill.

## Wave G (2026-11-07) — from final-audit-b.md
Audit B: the 64-room SCC holds by three causes (core barrel imported by 43 rooms; UI/settings/contracts consumed both ways; a domain mesh). FAS ≈110 edges, near-minimal. Groups G1–G7c simulate to SCC 1 / 0 mutual pairs.
- G1+G2 platform surface out of core → thr_4rw8e9tn77 (SWE-2 Flash high)
- G3+G6 UI kit leaf → thr_agws6iissb (LongCat 2.5)
- G4+G7a contracts + migrations leaves → thr_tzqp8jncww (SWE-2 Flash high)
- G7b shared constants down → thr_bjt4ue7sg5 (LongCat 2.5)
- G5 (writer/workflow ports) and G7c (runs split, critique/tasks/verification owner APIs) wait for F3 (writer failure fields) to merge — they touch the same files.
- G1+G2 merged 40d604d5 (review Grok: parity holds; one hidden link). Hidden link: platform re-exported `Services` type-only from server.ts, invisible to the graph. Fix in two parts: (a) room-graph counts code files outside src/rooms as ^nodes (c9d36c99) — honest numbers base 64/94 → now 70/56 (^server.ts in the SCC); (b) stream S thr_grk9acdh47 replaces the 87-field bag with per-function narrow deps typed by owner rooms.
- G4+G7a (plugin-contracts.ts at repo root) has the same shape; its review (Gemini) checks it with the new graph.

## Final audit A (Argon) → R1–R10, mapped
R1≈G1/G4 (done / in review), R2≈G5/G7c (after F3), R3≈G3+G6 (running), R5≈F3 (running).
New streams: R6+R9 hardcodes + duplicates → thr_pv7gnv9vqy (LongCat 2.5); R8 swallowed errors → thr_kzf5nymycm (SWE-2 Flash high).
Queued: R4 table ownership + database.ts split (after F3/G47 — same file), R7 micro-room merge (last: moves directories), R10 substring tests + 423 todos (last: tests are the safety net).
- G4+G7a merged ad57129d (review Gemini: 225 RPC + 79 host methods, schemas identical; contracts out 0 honest incl. type edges). Kept: anamnesis casts host.call to its own slice — tsc still rejects a wrong method name; the typed alternative (generic ServerCore<THost>) would ripple through every ServerCore user for one call site. Graph 90/68/54/721.

## 2026-11-07 — contracts holds no behaviour (G7b correction)
G7b started moving the errand episode recorder, memory-eval SQL loader and lead-road IO into `contracts`. Rejected: `contracts` keeps types, constants and pure value helpers only. Code with SQL, fs, `node:` modules, host calls, settings reads or state stays with its owner and reaches callers through narrow `Services` (owner `*Api` type, wired in core), or goes to `platform` when it has no domain owner. Check: no `node:`/`better-sqlite3`/`fs` import under src/rooms/contracts beyond base.

## 2026-11-07 — S and G3+G6 merged
main 12fe55a4: largestScc 45, mutualPairs 59, edges 719 (from 46/72/723). G5 (writer/workflow ports) started on swe-2-high from this base.

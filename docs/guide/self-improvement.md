---
title: Self-improvement
topic: self-improvement
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, self-improvement]
updated: 2026-11-27
sources:
  - packages/contracts/src/run-facts.ts
  - packages/contracts/src/evolve.ts
  - packages/contracts/src/loops.ts
  - packages/workflow-engine/src/node-form.ts
  - src/rooms/errands/models/process-key.ts
  - src/rooms/errands/server/handlers/errands-cli.ts
  - src/rooms/evolve/models/compare.ts
  - src/rooms/evolve/models/trial.ts
  - src/rooms/evolve/server/services/evolve-loop.ts
  - src/rooms/evolve/server/services/decide.ts
  - src/rooms/checkers/server/room.ts
  - src/rooms/lead/server/services/nearest.ts
  - src/rooms/reports/server/services/loop-health.ts
  - src/rooms/reports/server/services/review-desk.ts
  - docs/decisions/2026-11-25-evolution-graph.md
---

# Self-improvement and measurement

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Lane Pilot measures workflow steps, gates checkers against planted defects, supports `agent | plan | script` node forms, runs an event-driven evolution loop (`lp.evolve`), monitors loop health against kill criteria, and gathers all learning decisions onto one weekly owner review desk (`lp.review-desk`). Overnight loops (`wall`, `bench`, `rules`, `learning`, `harness`, `night-graphs`, `anamnesis`, `self-repair`) were removed.

## Step facts and node census

Every workflow step writes a structured row into `lane_pilot_wf_step` (`STEP_FACT_FIELDS` in `packages/contracts/src/run-facts.ts`): requested vs answered model, input/output/cache-read/cache-write tokens, list-price cost (`packages/models/src/model-prices.ts`, or `not_measured`), duration, `verdict` (`pass | fail | not_run`) with `failure_class`, rework visits, `graph_version`, `form_used`, `fallback_taken`, `environment_fingerprint`, and OTel GenAI attributes.

`nodeCensus()` classifies nodes from observed runs into `code`, `stable_agent`, and `open_agent` with per-category cost share, showing which repeated steps are ready to harden into plans or scripts.

## Node forms: script, plan, agent

Agent nodes can specify a `form` (`agent | plan | script`, `packages/workflow-engine/src/node-form.ts`):

- `script` runs deterministic code and requires both a mechanical `verify` check and an environment `fingerprint`.
- On failure or environment mismatch, execution falls back along `script -> plan -> agent`.
- Skipped or non-run checks report `not_run` (`verdict`), never `pass`.

## Errands and deterministic process keys

- **Diagnosis.** `bb lane-pilot errands diagnose [--days N] [--project ID] [--json]` (`src/rooms/errands/server/handlers/errands-cli.ts`, `errands-diagnosis.ts`) summarizes repeated errands and their cost. Finished errand runs record episode traces (`lane_pilot_errand_episode`) and PM/errand routing failures record catalog misses (`lane_pilot_route_miss`).
- **Process-key matching.** `nearestKeys` (`src/rooms/errands/models/process-key.ts`) scores up to 8 (`NEAREST = 8`) known process keys using Jaccard similarity over word stems (`candidate` + `title` against `entry.key` + `entry.titles`). `chooseProcessKey` does not call Jev or any model; it deterministically returns `{ key: candidate, how: nearestKeys(...).length ? "fallback" : "new" }`.

## Run verdicts and catalog misses

- **Run verdicts.** The owner accepts or rejects finished workflow runs via the `lane_pilot_run_verdict` PM tool or `bb lane-pilot run-verdict <runId> accept|reject [--reason <r>] [--note "<text>"]` (using `OWNER_REFUSAL_REASONS` from `packages/contracts/src/run-verdicts.ts`). Answering a terminal `human` gate also records a `human_node` verdict. Verdicts are stored in `lane_pilot_wf_run_verdict` and feed `lp.evolve` case sets and replay cases (`replayCasesFromRuns`).
- **Catalog misses.** When `lane_pilot_route` or errand routing finds no matching graph (`no_candidate`, `weak_match`, `blocked`, `near_miss`), `recordRouteMiss` writes a deduplicated entry to `lane_pilot_route_miss`. Discovery in `lead` (`listPathCandidates`) ranks recurring free-work and branch candidates from episodes, misses and `lane_pilot_trajectory_delta`.

## Evolution building blocks and checkers gate

`src/rooms/evolve/` holds the pure statistical comparison helpers and the `lp.evolve` loop implementation:

- `compareArms`, `pairedBootstrapInterval` and `computeNoise` (`src/rooms/evolve/models/compare.ts`) compare control and treatment arms over shared cases without hiding noise.
- `decideTrial` and `armMetrics` (`src/rooms/evolve/models/trial.ts`) run anytime-valid sequential canary monitoring against promotion and retirement bounds.
- **Checkers gate (`src/rooms/checkers/`).** `bb lane-pilot checkers score|scorecard|drill|defects` plants known defects into accepted candidates and scores each checker per defect class (requiring at least 90% detection on planted defects). See [docs/checkers.md](../checkers.md).

## Work-graph discovery (`lead`)

During `lead-tick` (hourly schedule row), `attachNearest`, `nearestUnits` and `formHypothesis` (`src/rooms/lead/server/services/nearest.ts`) plus `listPathCandidates` (`src/rooms/lead/server/services/path-candidates.ts`) group recurring graphless work and repeated trajectory deviations against known work-graph units and surface candidate hypotheses (`lane_pilot_lead_road`, PM tool `lane_pilot_lead`). See [docs/lead.md](../lead.md). New standalone skills follow [the skill standard](../skill-standard.md) and are validated with `bb lane-pilot skill-lint <dir>`.

## The `lp.evolve` loop

`lp.evolve` (`workflows/lp.evolve.json`, owned by room `evolve`) is the single evolution graph. It ships without `internal: true` so engine event triggers fire (`run-finished`, `threshold-crossed`, `catalog-changed`), while `not_for` keeps it out of manual/chat routing.

1. **Case sets (`lane_pilot_evolve_case`).** Accepted/rejected runs split into `working` and frozen `held_out` sets (protected by SQLite triggers unless rotated by the owner). Inspect and rotate with `bb lane-pilot evolve cases <workflowId>` and `bb lane-pilot evolve rotate <workflowId> <caseId…>`.
2. **Ledger, cursor and negative archive.** `lane_pilot_evolve_ingest` ensures each finished run is ingested once (`lp.evolve_ingest`). Variants rejected offline, retired in canary, or demoted for fallback spikes are recorded in the append-only `lane_pilot_evolve_negative` table so `lp.evolve` does not re-propose them.
3. **Hypothesis generator (`lp.evolve_propose`).** Proposes at most one node-level change per hypothesis across three arms (`model`, `form`, `check`) on graphs listed in `evolve.graphs` (default `["invoice-send"]`), capped by `EVOLVE_THRESHOLDS.activeCap` (`packages/contracts/src/evolve.ts`).
4. **Judge calibration (`lane_pilot_judge_calibration`).** Before an LLM pairwise judge can gate a graph, `src/rooms/critique/server/services/judge-calibration.ts` calibrates it against owner verdicts; judges must belong to a different `ModelFamily` (`packages/models/src/role-models.ts`) than the candidate node, and below the agreement threshold the judge stays advisory only.
5. **Dual-order pairwise judge & offline paired replay (`lp.evolve_replay`).** Evaluates candidate vs baseline on frozen held-out cases (`k` repeats + empty control, bounded by `evolve.replay_max_runs` = 120) respecting each step's `replayPolicy` (`live` for `R`, `stubbed` for `D`, `forbidden` for `L`/`S` — never replayed, checked on recorded outputs). Non-code steps use dual-order pairwise judging (`(reference, candidate)` and `(candidate, reference)` with swap ties); critic/verifier replacements must pass the planted-defect checker gate.
6. **Canary, promote, rollback and demote (`lp.evolve_decide`).** All sample-count gates, non-inferiority bounds, canary share, auto-promotion rules, first-reject auto-rollback, and script fallback demotion thresholds are defined in [the evolution decision record](../decisions/2026-11-25-evolution-graph.md) and [`EVOLVE_THRESHOLDS`](../../packages/contracts/src/evolve.ts) (copied here by reference, not duplicated by value). Below the sample threshold `lp.evolve` posts one `report_only` owner item and promotes only on owner approval (`bb lane-pilot evolve approve <hypothesisId>` / `reject` or the weekly desk); above it, `lp.evolve` opens a canary (`lane_pilot_evolve_trial`) and issues an evolution receipt in `lane_pilot_wf_publish_authority` when promoting or demoting.
7. **Catalog changes (`lp.evolve_reprove`).** On `lp.models.catalog-changed`, `lp.evolve` re-proves evolved model and `plan` nodes against frozen held-out cases so stale model assumptions do not linger.

## Loop modes and kill criteria

Each of the five learning loops (`LOOP_NAMES` in [`packages/contracts/src/loops.ts`](../../packages/contracts/src/loops.ts)) has an independent mode in `loops.mode`:

- `on` — normal operation (propose, run trials, promote within gates).
- `report` — analysis runs and surfaces findings on the weekly desk, without opening canary trials, publishing, or autonomous employee actions.
- `off` — loop skipped.

The canonical kill criteria live in [`KILL_CRITERIA`](../../packages/contracts/src/loops.ts) (the single source of truth). `loopHealth()` (`src/rooms/reports/server/services/loop-health.ts`) evaluates them strictly from SQLite records; when a criterion is breached, the weekly review desk defaults to switching that loop to `report`:

| Loop | Criterion in `KILL_CRITERIA` | Default desk action when breached |
|---|---|---|
| `discovery` | Fewer than `minAcceptedOfLast` (1) accepted in last `lastDraftsWindow` (3) settled `path-capture` drafts (abandoned after `staleDraftDays` = 14), or a published graph has `< minRunsIn30Days` (3) runs `postPublishDays` (30) days after publish | `switch to report-only` |
| `branches` | Fewer than `minAcceptedOfLast` (1) accepted in last `lastDraftsWindow` (3) settled branch drafts (stale after `staleDraftDays` = 14) | `switch to report-only` |
| `evolve` | At least `minProposedWithoutWin` (3) proposed hypotheses in `windowWeeks` (4) weeks with 0 promoted, or `>= minRollbacksIn30Days` (2) rollbacks in `rollbackWindowDays` (30) days | `switch to report-only` |
| `employee` | Conclusive outcome share (`within | above | below`) over `windowWeeks` (8) weeks is below `minConclusiveShare8w` (0.5) when verdicts exist | `switch to report-only` |
| `templates` | Fewer than `minAcceptedOfLast` (1) accepted in last `lastDraftsWindow` (3) settled `project-template` drafts (stale after `staleDraftDays` = 14) | `switch to report-only` |

## The weekly review desk

`lp.review-desk` (`workflows/lp.review-desk.json`, keeps `internal: true` and fires from its `startedBy: "review-desk"` schedule row, Monday 10:00 in `owner_push.timezone` by default) collects all non-urgent learning and maintenance decisions into one weekly owner review desk (`review-desk:<week>`):

- **Seven sections:** `candidates` (top ranked free/branch candidates), `drafts` (pending learned drafts), `evolve` (report-only hypotheses), `employee` (weekly scorecards, autonomy promotion candidates, proposed shared rules), `deferred` (decisions held back by the daily `decision_cap`), `loop-health` (breached kill criteria), and `durability` (informational hub-to-git drift summary naming `npm run graphs:export`).
- **Pre-selected conservative defaults.** Every item has a safe default (`later`, `keep draft`, `keep propose`, `keep local`, `switch to report-only`, or `approve`/`reject` based on measured gain). Silence changes nothing.
- **Surfaces and answers.** Telegram receives a compact `<= 40`-line summary (read-only); answers are recorded in BB via `bb lane-pilot desk show [--json]`, `bb lane-pilot desk answer <itemId> <option…> [--reason <text>]`, or `bb lane-pilot desk accept-defaults`.

## Coverage, baseline, forecast and plan against fact

- `bb lane-pilot coverage`: for every stage, transition, failure class, gate, memory path, room and mechanism, checks the drill scenario covering it.
- **Baseline:** Checks run once on base before the first writer (`baseline.already_built` `notify`, `baseline.time_cap_sec` `300`, `checks.require_red_on_base` `medium`). See [docs/baseline.md](../baseline.md).
- **Forecast & plan-fact:** A contract's hidden `forecast` is compared against accepted facts per area via `bb lane-pilot forecast [--project P] [--days 30]` ([docs/forecast.md](../forecast.md)). `plan_fact.mode` (`record` default, `gate`) checks acceptance evidence in code against the diff and verification results ([docs/plan-fact.md](../plan-fact.md)).

## Sources

Where this page's claims start in the code: `packages/contracts/src/run-facts.ts`, `packages/contracts/src/evolve.ts`, `packages/contracts/src/loops.ts`, `packages/workflow-engine/src/node-form.ts`, `src/rooms/errands/models/process-key.ts`, `src/rooms/evolve/models/compare.ts`, `src/rooms/evolve/models/trial.ts`, `src/rooms/evolve/server/services/evolve-loop.ts`, `src/rooms/reports/server/services/loop-health.ts`, `src/rooms/reports/server/services/review-desk.ts`, `src/rooms/lead/server/services/nearest.ts`. The deep pages linked above cite the rest.

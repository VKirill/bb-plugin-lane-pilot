---
title: Self-improvement
topic: self-improvement
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, self-improvement]
updated: 2026-11-22
sources:
  - packages/contracts/src/run-facts.ts
  - packages/workflow-engine/src/node-form.ts
  - src/rooms/errands/models/process-key.ts
  - src/rooms/errands/server/handlers/errands-cli.ts
  - src/rooms/evolve/models/compare.ts
  - src/rooms/evolve/models/trial.ts
  - src/rooms/checkers/server/room.ts
  - src/rooms/lead/server/services/nearest.ts
  - docs/decisions/2026-11-25-evolution-graph.md
---

# Self-improvement and measurement

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Lane Pilot measures workflow steps, gates checkers against planted defects, supports code/plan/agent node forms, and keeps pure comparison and work-graph discovery building blocks for event-driven graph evolution. Overnight loops (`wall`, `bench`, `rules`, `learning`, `harness`, `night-graphs`, `anamnesis`, `self-repair`) were removed.

## Step facts and node census

Every workflow step writes a structured row into `lane_pilot_wf_step` (`STEP_FACT_FIELDS` in `packages/contracts/src/run-facts.ts`): requested vs answered model, input/output/cache-read/cache-write tokens, list-price cost (`packages/models/src/model-prices.ts`, or `not_measured`), duration, `verdict` (`pass | fail | not_run`) with `failure_class`, rework visits, `graph_version`, `form_used`, `fallback_taken`, `environment_fingerprint`, and OTel GenAI attributes.

`nodeCensus()` classifies nodes from observed runs into `code`, `stable_agent`, and `open_agent` with per-category cost share, showing which repeated steps are ready to harden into plans or scripts.

## Node forms: script, plan, agent

Agent nodes can specify a `form` (`agent | plan | script`, `packages/workflow-engine/src/node-form.ts`):

- `script` runs deterministic code and requires both a mechanical `verify` check and an environment `fingerprint`.
- On failure or environment mismatch, execution falls back along `script -> plan -> agent`.
- Skipped or non-run checks report `not_run` (`verdict`), never `pass`.

## Errands and deterministic process keys

- **Diagnosis.** `bb lane-pilot errands diagnose [--days N] [--project ID] [--json]` (`src/rooms/errands/server/handlers/errands-cli.ts`, `errands-diagnosis.ts`) summarizes repeated errands and their cost.
- **Process-key matching.** `nearestKeys` (`src/rooms/errands/models/process-key.ts`) scores up to 8 (`NEAREST = 8`) known process keys using Jaccard similarity over word stems (`candidate` + `title` against `entry.key` + `entry.titles`). `chooseProcessKey` does not call Jev or any model; it deterministically returns `{ key: candidate, how: nearestKeys(...).length ? "fallback" : "new" }`.

## Evolution building blocks and checkers gate

`src/rooms/evolve/` holds the pure statistical comparison helpers:

- `compareArms`, `pairedBootstrapInterval` and `computeNoise` (`src/rooms/evolve/models/compare.ts`) compare control and treatment arms over shared cases without hiding noise.
- `decideTrial` and `armMetrics` (`src/rooms/evolve/models/trial.ts`) evaluate trial outcomes against promotion thresholds.
- **Checkers gate (`src/rooms/checkers/`).** `bb lane-pilot checkers score|scorecard|drill|defects` plants known defects into accepted candidates and scores each checker per defect class (requiring at least 90% detection on planted defects). See [docs/checkers.md](../checkers.md).

## Work-graph discovery (`lead`)

During `lead-tick` (hourly schedule row), `attachNearest`, `nearestUnits` and `formHypothesis` (`src/rooms/lead/server/services/nearest.ts`) group recurring graphless work against known work-graph units and surface candidate hypotheses (PM tool `lane_pilot_lead`). See [docs/lead.md](../lead.md). New standalone skills follow [the skill standard](../skill-standard.md) and are validated with `bb lane-pilot skill-lint <dir>`.

## `lp.evolve` design record

The target evolution graph is specified in [Self-evolution graph design record](../decisions/2026-11-25-evolution-graph.md) (not yet implemented):

- **Event-driven, no nightly cron.** Triggers on `run finished`, threshold breaches, or `model catalog changed`.
- **Sample gate.** Auto-promotion requires at least 20 held-out cases plus 10 working cases.
- **Judgment & scope.** Uses a dual-order pairwise judge and mutates graph structure and node forms rather than hand-tuning prompt prose.

## Coverage, baseline, forecast and plan against fact

- `bb lane-pilot coverage`: for every stage, transition, failure class, gate, memory path, room and mechanism, checks the drill scenario covering it.
- **Baseline:** Checks run once on base before the first writer (`baseline.already_built` `notify`, `baseline.time_cap_sec` `300`, `checks.require_red_on_base` `medium`). See [docs/baseline.md](../baseline.md).
- **Forecast & plan-fact:** A contract's hidden `forecast` is compared against accepted facts per area via `bb lane-pilot forecast [--project P] [--days 30]` ([docs/forecast.md](../forecast.md)). `plan_fact.mode` (`record` default, `gate`) checks acceptance evidence in code against the diff and verification results ([docs/plan-fact.md](../plan-fact.md)).

## Sources

Where this page's claims start in the code: `packages/contracts/src/run-facts.ts`, `packages/workflow-engine/src/node-form.ts`, `src/rooms/errands/models/process-key.ts`, `src/rooms/evolve/models/compare.ts`, `src/rooms/evolve/models/trial.ts`, `src/rooms/lead/server/services/nearest.ts`. The deep pages linked above cite the rest.

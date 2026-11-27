---
title: Goal-driven agent graphs target operating model
type: decisions
created: 2026-11-27
updated: 2026-11-27
status: accepted
confidence: medium
tags: [decisions, workflow-engine, evolve, specialist, memory, owner-waiting]
sources:
  - .ai-factory/research/goal-driven-agent-graphs/RESEARCH.md
  - .ai-factory/plans/goal-driven-agent-graphs/index.md
  - docs/decisions/2026-11-25-evolution-graph.md
  - packages/contracts/src/tool-tiers.ts
  - packages/contracts/src/work-kinds.ts
  - packages/contracts/src/cards.ts
  - packages/contracts/src/loops.ts
  - packages/contracts/src/evolve.ts
  - packages/contracts/src/specialist.ts
  - packages/contracts/src/publish-grant.ts
---

# Goal-driven agent graphs target operating model

Accepted by the owner on 2026-11-26 and implemented across Phases 1–12 of `.ai-factory/plans/goal-driven-agent-graphs/index.md` (superseding the minimum-viable draft `.ai-factory/plans/goal-driven-agent-graphs-mvp.md`).

## Context

Research in `.ai-factory/research/goal-driven-agent-graphs/RESEARCH.md` (2026-11-26) examined how Lane Pilot should run routine work, standing domain "employees", and multi-stage goal projects on contracted graphs that any model can follow and improve safely. Earlier ad-hoc self-growth loops failed from chat-transcript re-reading, duplicate graph sprawl, missing run verdicts, unlinked outcome forecasts, and unbounded owner notifications. Meanwhile, `docs/decisions/2026-11-25-evolution-graph.md` established the statistical and judging design of `lp.evolve`, and the pause-prune plan kept both `specialist` and the `lead` road tables (`DEC-R1`).

## Decisions

1. **Rails first, scripts second (ADR-0001).** A trodden path is primarily a contract-and-checks harness (`effect`, `produces`/`consumes`, `verify`, `gates`, `proven_on`, instruction budget warnings) that lets cheaper models pass deterministically. Compiling a step to `script` is an optional optimization only for stable parametric steps with a mechanical verifier and environment fingerprint, keeping `plan -> agent` fallback.
2. **One step standard.** Every node can declare `effect` (`R | D | L | S` from `packages/contracts/src/tool-tiers.ts`), which governs both replay (`live` for `R`, `stubbed` for `D`, `forbidden` for `L`/`S`), static ungated-irreversible warnings (`effect_irreversible_ungated`), and runtime MCP enforcement (`LANE_PILOT_NODE_EFFECT` in `lane-stack/hooks/guard_shell.py`). Graphs also record `proven_on` model proof receipts (`lane_pilot_wf_proof`).
3. **Three work kinds on one mechanism (ADR-0002, DEC-R1).** Workflows share one engine with `kind` (`routine | employee | project` in `packages/contracts/src/work-kinds.ts`). Long-running `project` runs pin stage graph revisions via `lane_pilot_wf_definition` and extract reusable `project` templates from accepted, goal-audited runs. Standing `employee` shifts build their case folder on Specialist OS + `lane_pilot_lead_road`: expected-vs-measured decision log (`lane_pilot_sp_intent_outcome`), hypothesis tree with `triedAlready` (`lane_pilot_sp_hypothesis`), attributed local/shared rules (`lane_pilot_sp_rule`), and bounded shift snapshots (`sp.load_memory`), with earned per-action-class autonomy (`observe | propose | bounded_auto` in `packages/contracts/src/specialist.ts`).
4. **Recording before learning.** Run ends (`LP_EVENTS.WORKFLOW_RUN_FINISHED`), errand episode traces (`lane_pilot_errand_episode`), catalog misses (`lane_pilot_route_miss`), owner interventions (`lane_pilot_trajectory_delta`), and explicit owner verdicts (`lane_pilot_wf_run_verdict`) are persisted in SQLite before any discovery, branch, template, or evolution loop reads them.
5. **Cards as data in hub memory.** Niche, brand, contact, and platform facts live as typed knowledge cards (`packages/contracts/src/cards.ts`, `CARD_KINDS`, `CARD_LIMITS`) with `verifiedAt`, source trust (`confirmed | observed`), and TTL. Expired cards enter briefs marked `UNVERIFIED`; `lp.cards_load` wraps them in `<data>...<cards>...</cards></data>` fences; `validateWorkflowRails` warns if prompts leave learned text unfenced or if judge nodes read cards.
6. **One draft path, one publish gate (`lane_pilot_wf_publish_authority`).** Path capture, branch capture, project templates, and `lp.evolve` hypotheses all flow through `createWorkflowArchitect`, structural dedup (`createDedupeGate`), and permission-widening guards (`draft-guard-policy.ts`). Publishing atomically consumes a SHA-bound `PublishAuthority` (`PublishGrant` from `desk | cli | chat`, or `EvolutionReceipt` from `lp.evolve`). Learned edits may never widen permissions without an explicit owner grant or touch evaluators.
7. **Single evolution graph (`lp.evolve`).** `lp.evolve` (`workflows/lp.evolve.json`, owned by room `evolve`) is the only self-modification loop. It implements the gates, dual-order cross-family calibrated judging, paired replay, canary monitoring, negative archive, and threshold table from `docs/decisions/2026-11-25-evolution-graph.md` (`EVOLVE_THRESHOLDS` in `packages/contracts/src/evolve.ts`).
8. **Attention budget and brakes in code.** Daily owner wake-ups for `decision` items are capped by `decision_cap` (default `5`, matching `NOW_CAP`); excess decisions defer to one weekly review desk (`lp.review-desk`, Monday 10:00 local by default, conservative pre-selected defaults, silence changes nothing). Every autonomous start path checks `schedule.paused_all` and `workflow.disabled`. Each of the five learning loops (`discovery`, `branches`, `evolve`, `employee`, `templates`) has an independent `on | report | off` mode (`loops.mode`) and SQLite-measured `KILL_CRITERIA` (`packages/contracts/src/loops.ts`).
9. **One home per vocabulary.** Shared enums and thresholds live in `@lane-pilot/contracts` (`packages/contracts/src/`) and `packages/kit/src/hash.ts` (`canonicalJson`), guarded by `tests/architecture/single-vocabulary.test.ts`.

## Consequences

- **Hub-to-git durability:** Because the hub cannot commit directly to a git checkout, evolved and newly published graphs on the hub are exported explicitly via `npm run graphs:export` (`scripts/export-hub-graphs.ts`), with drift surfaced in the weekly review desk's `durability` section.
- **Recorded implementation deviations:**
  - `workflows/lp.evolve.json` ships without `internal: true` so engine event triggers fire (`workflow-triggers.ts` skips internal graphs on event matching), while `lp.review-desk.json` retains `internal: true` because it fires through its own `startedBy` schedule row.
  - The weekly review desk's `durability` section uses `composeDurabilityDeskSection` as an informational `noop` item naming `npm run graphs:export`.
  - Path/branch saving resolves base file SHA-256 via `workflowLibrary.source()` (raw file bytes) and passes the same loader into both the PM tool and the desk answer handler so branch publishes do not spuriously fail with `file_conflict` or `unknown_graph`.
- **Superseded draft:** `.ai-factory/plans/goal-driven-agent-graphs-mvp.md` is superseded by `.ai-factory/plans/goal-driven-agent-graphs/index.md` and this decision record.

## Open Items and Known Limitations

- **MCP effect-check coverage:** Runtime `LANE_PILOT_NODE_EFFECT` enforcement only runs where `lane-stack/hooks/guard_shell.py` executes; clients without that hook are not covered.
- **Weekly desk surface:** Telegram delivers the `<= 40`-line review desk summary read-only; answers stay in BB (`bb lane-pilot desk ...`).
- **Pilot routine selection and real-account calibration:** `workflows/invoice-send.json` is pilot routine 1; pilot routines 2–3, calibrated `decision_cap` / silence policy, and multi-week employee outcome validation (`RISK-6` in research) depend on live production traffic and kill-criteria checks.
- **Weak external evidence base:** Research constraints noted that external sources were mostly 2026 preprints and small repos; therefore all thresholds live as named constants (`EVOLVE_THRESHOLDS`, `KILL_CRITERIA`) and settings rather than literals.
- **Desk-answer branch path:** `DeskAnswerDeps.loadWorkflow` fix for project graphs on the desk-answer path was verified during Task 54 integration work and has no dedicated standalone drill test yet.
- **Research ADR status:** `ADR-0001` and `ADR-0002` under `.ai-factory/research/goal-driven-agent-graphs/` remain owned by `/aif-explore` and still need their status header updated from `proposed` to `accepted`.

---
title: "Trajectory crystallization, skill intent resolution, and nightly workflow evolution"
type: component
created: 2026-11-18
updated: 2026-11-20
status: active
confidence: high
tags: [workflows, evolution, night-graphs, skills, pilot-panel, categories]
sources:
  - src/rooms/errands/skill-intent.ts
  - src/rooms/errands/episode-enrich.ts
  - src/rooms/errands/trajectory-delta.ts
  - src/rooms/night-graphs/server/pilot-day-digest.ts
  - src/rooms/storage/analytics-store.ts
  - packages/workflow-engine/src/draft-store.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/validate.ts
  - src/rooms/night-graphs/deprojectize.ts
  - src/rooms/night-graphs/server/graph-evolve-graph.ts
  - src/rooms/night-graphs/server/graph-evolve-pipeline.ts
  - src/rooms/night-graphs/server/graph-evolve-suite.ts
  - src/rooms/workflow/categories.ts
  - src/rooms/workflow/ui/workflow-map.tsx
  - src/rooms/workflow/ui/workflow-library-parts.tsx
  - src/rooms/workflow/ui/workflows.tsx
  - src/rooms/workflow/workflow-export.ts
  - src/rooms/pilot-panel/process-state.ts
  - src/rooms/pilot-panel/server/workflow-drafts.ts
  - src/rooms/pilot-panel/server/rpc.ts
  - src/rooms/pilot-panel/contract.ts
  - src/rooms/pilot-panel/ui/process-state-section.tsx
  - src/rooms/pilot-panel/ui/workflow-drafts-section.tsx
  - src/rooms/workflow/builtin.ts
  - workflows/lp.graph-evolve-nightly.json
---

# Trajectory crystallization, skill intent resolution, and nightly workflow evolution

TL;DR: Without live per-message interceptors, `lp.graph-evolve-nightly` begins with autonomous deep trajectory digestion over Pilot runs, unactivated parent chats, child workflow runs, and user workflows (`src/rooms/night-graphs/server/pilot-day-digest.ts:219-343`), writes masked interventions into `lane_pilot_trajectory_delta` (`src/rooms/errands/trajectory-delta.ts:17-46`, `src/rooms/errands/trajectory-delta.ts:125-191`) and daily summaries into `lane_pilot_day_digest` (`src/rooms/storage/analytics-store.ts:398-416`), clusters episodes by exact `process_key` and domain family (`src/rooms/night-graphs/server/graph-evolve-graph.ts:55-165`), runs a 4-model cross-family pipeline (`planner` -> `plan-critic` -> `workflow-architect` -> `auditor`) in `$HOME/.lane-pilot/graph-evolve` (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:151-363`), filters for de-projectization (`src/rooms/night-graphs/deprojectize.ts:71-106`), validates and stub-tests connected `subworkflow` suites in `leaves -> orchestrator` topological order (`src/rooms/night-graphs/server/graph-evolve-suite.ts:82-442`), and either auto-publishes minor patches / approved suites or queues structural/new graphs for 1-click owner approval in the Pilot panel (`src/rooms/pilot-panel/server/workflow-drafts.ts:130-188`).

## How it works

1. **Resolve skill intent and record actual skill usage**: `hasExplicitSkillIntent` detects RU/EN skill-request phrasing via `EXPLICIT_INTENT_RE` (`src/rooms/errands/skill-intent.ts:61-116`), and `resolveSkillIntent` ranks catalog entries by normalized name hits, `stems` from `@lane-pilot/workflow-engine`, and `SKILL_DOMAIN_SYNONYMS` across `copywriting`, `seo`, `design`, `qa`, and `architecture` (`src/rooms/errands/skill-intent.ts:29-51`, `src/rooms/errands/skill-intent.ts:122-208`). During episode enrichment, `episodeSkills` combines offered skills with un-offered skills discovered via `skillReadsOf` (`*/SKILL.md` file reads) and `directSkillCallsOf` (`skill` tool calls), emitting `{ name, offered: false, read, used }` (`src/rooms/errands/episode-enrich.ts:123-182`).
2. **Capture masked trajectory deltas**: `recordTrajectoryDelta` validates `TRAJECTORY_INTERVENTION_KINDS` (`skill_request`, `rule_added`, `step_inserted`, `reference_branch`, `variant_selected`), passes `rawSummary` through `redactKnown`, `scrubQuote`, and `maskPii`, resolves explicit skills, and executes `INSERT OR IGNORE` into the append-only table `lane_pilot_trajectory_delta` protected by `lane_pilot_trajectory_delta_no_delete` (`src/rooms/errands/trajectory-delta.ts:17-46`, `src/rooms/errands/trajectory-delta.ts:125-191`).
3. **Deep trajectory digestion (`lp.graph_evolve_digest`)**: Every day at `50 4 * * *` (`GRAPH_EVOLVE_CRON`), `mountGraphEvolveNightly` triggers `lp.graph-evolve-nightly` under daily idempotency key `wfTerminalByIdemKey` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:31-33`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:325-337`); manual `workflow_run` calls also accept `project_id`, `lookback_days` (`1..90`), and `publish_approved_suite` (`workflows/lp.graph-evolve-nightly.json:33-49`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:208-216`). `digestPilotDayDialogues` (`src/rooms/night-graphs/server/pilot-day-digest.ts:219-343`) invokes `listPilotDayCandidates` (`src/rooms/storage/analytics-store.ts:308-395`) with optional `projectId` filtering over `DEFAULT_WINDOW_MS` × `lookbackDays` (`src/rooms/night-graphs/server/pilot-day-digest.ts:56`, `src/rooms/night-graphs/server/pilot-day-digest.ts:221-224`) to gather:
   - `lane_pilot_run` PM threads with `lane_pilot_task`, `lane_pilot_attempt`, and `lane_pilot_stage_receipt` records (`src/rooms/storage/analytics-store.ts:318-344`).
   - Pilot-activated chats (`lane_pilot_activation`, `lane_pilot_pm_notice`) as well as unactivated parent chats discovered from `lane_pilot_wf_run` child triggers (`errand`, `specialist`, `web-research`, `research-dossier`, `browser-step`, `seo-*`, `sp.*`/`sp-*` via `CHILD_WF_FILTER` at `src/rooms/storage/analytics-store.ts:252`, `src/rooms/storage/analytics-store.ts:347-368`).
   - Completed non-errand user `lane_pilot_wf_run` runs (`src/rooms/storage/analytics-store.ts:370-389`).
   `attachTrajectoryFacts` (`src/rooms/storage/analytics-store.ts:259-305`) joins enriched child `episodes` and `childRuns` onto each candidate. `digestPilotDayDialogues` merges `judgedCorrectionRows`, reads parent and up to 5 child thread outlines/events, extracts observed MCP servers (`metamcp`, `pencil`, `gitnexus`, `blender`) and BB plugins (`image-studio`, `browser-automation`, `env-catalog`) via `detectIntegrations` (`src/rooms/night-graphs/server/pilot-day-digest.ts:145-169`), masks all text via `maskText` (`redactKnown -> scrubQuote -> maskPii`, `src/rooms/night-graphs/server/pilot-day-digest.ts:64-65`), selects `analyst` when `richness >= 2` or `episode-analyst` otherwise (`src/rooms/night-graphs/server/pilot-day-digest.ts:294-296`), and persists interventions into `lane_pilot_trajectory_delta` and daily summaries into `lane_pilot_day_digest` via `savePilotDayDigest` (`src/rooms/storage/analytics-store.ts:398-416`).
4. **Cluster evidence with domain-family singleton grouping (`lp.graph_evolve_collect`)**: `collectGraphEvolveEvidence` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:66-165`) combines unprocessed deltas from `listUnprocessedTrajectoryDeltas`, enriched errand episodes (`listErrandEpisodeRows`), and `listPilotDayDigests` (promoting multi-task or delta-backed `pilot_run` items via `richPilotRun` at line `118`). Exact `processKey` clusters reaching `minCluster` or `richPilotRun` advance directly; remaining singleton episodes are bucketed by `domainFamilyOf` (`websites`, `seo`, `marketing`, `media`, or prefix) into `${fam}|trajectory-suite` clusters (or `${dominant}|project-trajectory` per project) so distinct singleton episodes in one domain still crystallize into a connected suite (`src/rooms/night-graphs/server/graph-evolve-graph.ts:55-63`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:130-157`).
5. **Run the 4-model cross-family evolution pipeline (`planner` -> `plan-critic` -> `workflow-architect` -> `auditor`)**: When `collect.status` is not `'empty'`, `lp.graph-evolve-nightly` runs `plan_blueprint` (`lp.graph_evolve_plan`), short-circuits to `noop_done` when `decision == 'noop'`, or loops through `critique_plan` (`lp.graph_evolve_critique`, up to `visits('plan_blueprint') < 2`), `synthesize` (`lp.graph_evolve_synthesize`, with an automatic schema/stub repair pass on validation errors at `src/rooms/night-graphs/server/graph-evolve-graph.ts:285-293`), `audit_suite` (`lp.graph_evolve_audit`, up to `visits('synthesize') < 2`), and `apply` (`workflows/lp.graph-evolve-nightly.json:62-281`). Each role runs in `$HOME/.lane-pilot/graph-evolve` via `createLiveEvolveRoleRunner` + `resolveSpawnModel` (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:151-198`):
   - `planEvolutionBlueprint` (`planner`): emits a de-projectized `ProcessBlueprint` with `orderInvariants`, `variantParameters`, `requiredIntegrations`, and connected `phase_graph` + `master_orchestrator` specs (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:37-45`, `src/rooms/night-graphs/server/graph-evolve-pipeline.ts:201-233`).
   - `critiqueEvolutionBlueprint` (`plan-critic`): audits the blueprint on 6 hard gates (MCP/plugin fidelity, multi-variant parameters, causal step ordering, modular `2..5` phase graphs + orchestrator, 100% de-projectization, clear contracts) (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:236-267`).
   - `synthesizeSuiteFromBlueprint` (`workflow-architect`): compiles `ProcessBlueprint` into `GraphEvolveCandidate[]` JSON respecting `WORKFLOW_REFERENCE`, strict `nodeSchema`, `subworkflow` `{{...}}` bindings, and stub test cases (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:270-334`).
   - `auditSynthesizedSuite` (`auditor`): verifies compiled candidate JSONs item-by-item against the approved blueprint and masked evidence before `apply` (`src/rooms/night-graphs/server/graph-evolve-pipeline.ts:337-363`).
6. **Two-pass topological `subworkflow` validation, CAS publication, and test receipts**:
   - `topologicalSortSuite` orders candidates `leaves -> orchestrator` via `extractSubworkflowRefs` and isolates `subworkflow_cycle` graphs (`src/rooms/night-graphs/server/graph-evolve-suite.ts:72-148`).
   - `validateEvolveSuiteCandidates` (`src/rooms/night-graphs/server/graph-evolve-suite.ts:185-247`) and `applyGraphEvolveCandidates` (`src/rooms/night-graphs/server/graph-evolve-suite.ts:250-442`) run Pass-1 structure parsing, propagate `dependency_failed:<child>` atomically to any parent whose child failed (`src/rooms/night-graphs/server/graph-evolve-suite.ts:312-319`), enforce `checkDeprojectization` (`src/rooms/night-graphs/deprojectize.ts:71-106`), perform Pass-2 `loadWorkflow` resolution against `suiteMap` + `baseStore` + `builtinWorkflow`, and execute `runDraftTest` across every linked workflow (`src/rooms/night-graphs/server/graph-evolve-suite.ts:330-350`).
   - `classifyEvolutionDiff` marks topology, permission, breaking-input, skill-removal, `category_changed`, or `new_v1` changes as `structural_or_new`, leaving skill additions, copy/check refinements, and optional inputs as `minor_patch` (`src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/deprojectize.ts:118-196`, `packages/workflow-engine/src/draft-store.ts:232-241`).
   - Minor patches with a `baseDef`, or suites run with `publish_approved_suite: true` and `audit_suite.verdict == "pass"`, are written via `casWriteWorkflowFile`, stamped with `createStatusResolver.recordTest` receipts so published graphs stay green without `"untested"` downgrades, mark cited deltas processed, and emit a non-waking `workflow_evolved_digest` card with 1-click rollback (`src/rooms/night-graphs/server/graph-evolve-suite.ts:362-420`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:317-321`). Structural/new drafts without `publishApprovedSuite` remain `status: "tested"` and post a waking `workflow_draft_proposed` owner item (`src/rooms/night-graphs/server/graph-evolve-suite.ts:421-433`).
7. **Persist process state and operate from Pilot panel**: `.agents/pilot/process-state.json` is validated by `pilotProcessStateSchema` and updated via `readPilotProcessStateCas` / `writePilotProcessStateCas` (`src/rooms/pilot-panel/process-state.ts:3-19`, `src/rooms/pilot-panel/process-state.ts:86-159`), with `formatProcessStatePromptLine` projecting the stage and approved baseline into prompt lines (`src/rooms/pilot-panel/process-state.ts:161-172`). `PilotProcessStateSection` and `PilotWorkflowDraftsSection` render the checkpoint and evolution drafts in the right panel (`src/rooms/pilot-panel/ui/process-state-section.tsx:5-65`, `src/rooms/pilot-panel/ui/workflow-drafts-section.tsx:21-96`), backed by `pilot_panel_publish_workflow_draft` and `pilot_panel_rollback_workflow_draft` (`src/rooms/pilot-panel/server/rpc.ts:73-76`, `src/rooms/pilot-panel/server/workflow-drafts.ts:130-188`).

## Trajectory crystallization, daily digestion, and skill intent

| Component | Responsibility | Source |
|---|---|---|
| `resolveSkillIntent` | Bilingual RU/EN stem and domain-synonym scoring against catalog items | `src/rooms/errands/skill-intent.ts:122-208` |
| `hasExplicitSkillIntent` | Detects explicit owner instructions to apply skills or rules via `EXPLICIT_INTENT_RE` | `src/rooms/errands/skill-intent.ts:61-116` |
| `episodeSkills` | Tracks `{ offered, read, used }` including un-offered `SKILL.md` reads | `src/rooms/errands/episode-enrich.ts:161-182` |
| `recordTrajectoryDelta` | Masks and deduplicates chat/run interventions in `lane_pilot_trajectory_delta` | `src/rooms/errands/trajectory-delta.ts:125-191` |
| `listUnprocessedTrajectoryDeltas` | Feeds unconsumed owner-accepted deltas to the nightly collector | `src/rooms/errands/trajectory-delta.ts:194-214` |
| `listPilotDayCandidates` / `attachTrajectoryFacts` | Queries `lane_pilot_run`, Pilot/child-triggered chats, and user workflows; attaches child `episodes` + `childRuns` | `src/rooms/storage/analytics-store.ts:252-395` |
| `digestPilotDayDialogues` | Extracts MCP/plugins (`detectIntegrations`), picks `analyst` vs `episode-analyst`, writes deltas and `lane_pilot_day_digest` | `src/rooms/night-graphs/server/pilot-day-digest.ts:145-343` |
| `savePilotDayDigest` / `listPilotDayDigests` | Idempotently stores daily digests and supplies 14-day summaries to `collectGraphEvolveEvidence` | `src/rooms/storage/analytics-store.ts:398-425` |

## 4-model pipeline, topological suite gate, and publication (`lp.graph-evolve-nightly`)

`lp.graph-evolve-nightly` (`src/rooms/workflow/builtin.ts:54`, `src/rooms/workflow/builtin.ts:195`) wires `digest` -> `collect` -> `plan_blueprint` -> `critique_plan` -> `synthesize` -> `audit_suite` -> `apply` -> `done`, with `empty_done` when `collect.status == 'empty'`, `noop_done` when `plan_blueprint.decision == 'noop'`, and bounded `maxVisits: 2` rework loops at `critique_plan -> plan_blueprint` and `audit_suite -> synthesize` (`workflows/lp.graph-evolve-nightly.json:62-281`).

| Gate / Pipeline Stage | Outcome | Source |
|---|---|---|
| `planEvolutionBlueprint` / `critiqueEvolutionBlueprint` | Produces de-projectized `ProcessBlueprint` (`noop`, `minor_patch`, `suite_or_structural`) and audits 6 fidelity/safety gates | `src/rooms/night-graphs/server/graph-evolve-pipeline.ts:201-267` |
| `synthesizeSuiteFromBlueprint` / `auditSynthesizedSuite` | Compiles `GraphEvolveCandidate[]` (with repair pass on schema/test errors) and verifies blueprint/MCP/order fidelity | `src/rooms/night-graphs/server/graph-evolve-pipeline.ts:270-363`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:268-310` |
| `topologicalSortSuite` + `dependency_failed` | Resolves `subworkflow` graphs `leaves -> orchestrator`, isolates cycles (`subworkflow_cycle`), propagates child failures to parents | `src/rooms/night-graphs/server/graph-evolve-suite.ts:72-148`, `src/rooms/night-graphs/server/graph-evolve-suite.ts:296-319` |
| `checkDeprojectization` finding (`abs_path`, `project_id`, `host_id`, `project_name_or_domain`, `secret_shape`, `forbidden_grant`) | Candidate rejected (`rejected_deprojectize`) before draft creation | `src/rooms/night-graphs/deprojectize.ts:4-106`, `src/rooms/night-graphs/server/graph-evolve-suite.ts:320-329` |
| `loadWorkflow` error or failing `runDraftTest` | Candidate rejected (`rejected_invalid` or `rejected_tests`) and blocked from parent resolution | `src/rooms/night-graphs/server/graph-evolve-suite.ts:330-350` |
| `minor_patch` with `baseDef`, or `publish_approved_suite` with `audit_suite.verdict == 'pass'` | CAS-written via `casWriteWorkflowFile`, stamped with `createStatusResolver.recordTest`, posts `workflow_evolved_digest` with rollback button | `src/rooms/night-graphs/server/graph-evolve-suite.ts:362-420`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:317-321` |
| `structural_or_new` or new `v1` without `publish_approved_suite` | Draft saved as `tested`; `workflow_draft_proposed` posted for owner approval | `src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/server/graph-evolve-suite.ts:421-433` |
| `listEvolutionDrafts` and `previousVersionSnapshot` | Powers panel draft listing and validated rollback to prior published version | `packages/workflow-engine/src/draft-store.ts:215-263`, `src/rooms/pilot-panel/server/workflow-drafts.ts:149-188` |

## Open bilingual dynamic graph categories (`category`)

`workflowSchema` and `normalizeWorkflow` (`packages/workflow-engine/src/schema.ts:23-26`, `packages/workflow-engine/src/schema.ts:275`, `packages/workflow-engine/src/schema.ts:447-450`) accept optional `category` (`slug` or `{ id, label: { en, ru } }`), while `validateWorkflow` (`packages/workflow-engine/src/validate.ts:78-80`) enforces `category_label_required` whenever `category.id` is outside the 9 built-in shelves (`WORKFLOW_CATEGORIES` in `src/rooms/workflow/categories.ts:5`).

- **Autonomous synthesis instead of manual built-in placeholders**: Manual built-in placeholders (such as the former built-in `site-creation` graph) were removed from `BUILTIN_SOURCES` (`src/rooms/workflow/builtin.ts:141-271`) so dynamic shelves such as `websites` (`{ id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } }`) and their multi-graph suites are synthesized and published autonomously by `lp.graph-evolve-nightly` from real project trajectories (`src/rooms/night-graphs/server/graph-evolve-graph.ts:138-144`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:168-194`).
- **Evolution, de-projectization, and UI/export surface**: `classifyEvolutionDiff` treats a `category.id` change on an existing published graph as `structural_or_new` (`category_changed` in `src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/deprojectize.ts:187-189`), and `checkDeprojectization` rejects project-specific category slugs/labels (`src/rooms/night-graphs/deprojectize.ts:71-106`). Dynamic categories render as dedicated clusters, shelves, and filter chips across `src/rooms/workflow/ui/workflow-map.tsx:47-58` (deterministic `oklch` hues via `dynamicHue` / `catColor`), `src/rooms/workflow/ui/workflow-map.tsx:176-225`, `src/rooms/workflow/ui/workflow-map.tsx:550-577`, `src/rooms/workflow/ui/workflow-library-parts.tsx:28-64`, `src/rooms/workflow/ui/workflow-library-parts.tsx:96-131`, `src/rooms/workflow/ui/workflows.tsx:117-118`, `src/rooms/workflow/ui/workflows.tsx:242`, `src/rooms/workflow/ui/workflows.tsx:266-270`, and `src/rooms/workflow/workflow-export.ts:26-31`, `src/rooms/workflow/workflow-export.ts:61-77`, `src/rooms/workflow/workflow-export.ts:97-105`.

## Process state checkpoint (`lp.save_process_state`)

Synthesized workflows can checkpoint design/process state via `lp.save_process_state` (`src/rooms/pilot-panel/server/workflow-drafts.ts:190-219`), persisting `approvedDesignBaseline`, `stage`, `rejectedVariants`, and `activeSkills` in `.agents/pilot/process-state.json` via `writePilotProcessStateCas` (`src/rooms/pilot-panel/process-state.ts:86-159`) so downstream build/QA stages read the locked baseline through `formatProcessStatePromptLine` (`src/rooms/pilot-panel/process-state.ts:161-172`).

See [Everything is a graph](guide/graphs.md) for the workflow catalog and [Night policy](night-policy.md) for general night-loop boundaries.

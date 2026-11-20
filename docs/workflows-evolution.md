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
  - packages/workflow-engine/src/router.ts
  - workflows/lp.graph-evolve-nightly.json
  - workflows/site-creation.json
---

# Trajectory crystallization, skill intent resolution, and nightly workflow evolution

TL;DR: Without live per-message interceptors, `lp.graph-evolve-nightly` begins with autonomous nightly digestion of the past 24 hours of Pilot runs, Pilot-activated chats, and user workflows (`src/rooms/night-graphs/server/pilot-day-digest.ts:171-265`), writes masked interventions into `lane_pilot_trajectory_delta` (`src/rooms/errands/trajectory-delta.ts:17-46`, `src/rooms/errands/trajectory-delta.ts:125-191`) and daily summaries into `lane_pilot_day_digest` (`src/rooms/storage/analytics-store.ts:330-348`), synthesizes universal graphs with open bilingual `category` metadata in `$HOME/.lane-pilot/graph-evolve` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:287-324`, `packages/workflow-engine/src/schema.ts:23-26`), filters for de-projectization (`src/rooms/night-graphs/deprojectize.ts:71-106`), and either auto-publishes minor patches or queues structural/new graphs for 1-click owner approval in the Pilot panel (`src/rooms/pilot-panel/server/workflow-drafts.ts:130-188`).

## How it works

1. **Resolve skill intent and record actual skill usage**: `hasExplicitSkillIntent` detects RU/EN skill-request phrasing via `EXPLICIT_INTENT_RE` (`src/rooms/errands/skill-intent.ts:61-116`), and `resolveSkillIntent` ranks catalog entries by normalized name hits, `stems` from `@lane-pilot/workflow-engine`, and `SKILL_DOMAIN_SYNONYMS` across `copywriting`, `seo`, `design`, `qa`, and `architecture` (`src/rooms/errands/skill-intent.ts:29-51`, `src/rooms/errands/skill-intent.ts:122-208`). During episode enrichment, `episodeSkills` combines offered skills with un-offered skills discovered via `skillReadsOf` (`*/SKILL.md` file reads) and `directSkillCallsOf` (`skill` tool calls), emitting `{ name, offered: false, read, used }` (`src/rooms/errands/episode-enrich.ts:123-182`).
2. **Capture masked trajectory deltas**: `recordTrajectoryDelta` validates `TRAJECTORY_INTERVENTION_KINDS` (`skill_request`, `rule_added`, `step_inserted`, `reference_branch`, `variant_selected`), passes `rawSummary` through `redactKnown`, `scrubQuote`, and `maskPii`, resolves explicit skills, and executes `INSERT OR IGNORE` into the append-only table `lane_pilot_trajectory_delta` protected by `lane_pilot_trajectory_delta_no_delete` (`src/rooms/errands/trajectory-delta.ts:17-46`, `src/rooms/errands/trajectory-delta.ts:125-191`).
3. **Digest daily Pilot dialogues and outcomes nightly (`lp.graph_evolve_digest`)**: Without any live per-message interceptors, `lp.graph-evolve-nightly` starts with `digest` (`lp.graph_evolve_digest` -> `collect` -> `synthesize` -> `apply` in `workflows/lp.graph-evolve-nightly.json:33-158`). Every day at `50 4 * * *` (`GRAPH_EVOLVE_CRON`), `mountGraphEvolveNightly` triggers `lp.graph-evolve-nightly` under daily idempotency key `wfTerminalByIdemKey` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:19-21`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:339-378`). `digestPilotDayDialogues` (`src/rooms/night-graphs/server/pilot-day-digest.ts:171-265`) queries `listPilotDayCandidates` (`src/rooms/storage/analytics-store.ts:250-327`) over the past 24 hours (`DEFAULT_WINDOW_MS`) for `lane_pilot_run` PM threads + writer/helper `lane_pilot_attempt` + `lane_pilot_stage_receipt`, Pilot-activated chats (`lane_pilot_activation` / `lane_pilot_pm_notice`), and completed non-errand user `lane_pilot_wf_run` runs, merges `judgedCorrectionRows`, masks all text via `redactKnown -> scrubQuote -> maskPii` (`src/rooms/night-graphs/server/pilot-day-digest.ts:61-62`), runs `episode-analyst` in `$HOME/.lane-pilot/graph-evolve` (`src/rooms/night-graphs/server/pilot-day-digest.ts:278-325`), and records interventions idempotently into `lane_pilot_trajectory_delta` and daily summaries into `lane_pilot_day_digest` via `savePilotDayDigest` (`src/rooms/storage/analytics-store.ts:330-348`).
4. **Collect evidence and synthesize in an isolated room**: `collectGraphEvolveEvidence` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:71-135`) merges unprocessed deltas from `listUnprocessedTrajectoryDeltas` with both enriched errand episodes (`listErrandEpisodeRows`) and `listPilotDayDigests` (including multi-task or delta-backed `pilot_run` clusters via `richPilotRun`, `lessons`, and `categoryHint`). When `status` is `"ready"`, `synthesizeInIsolatedRoom` prepares `$HOME/.lane-pilot/graph-evolve`, passes `collectKnownCategories` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:274-285`) and masked evidence to `services.ruleScan.runAnalyzer` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:287-324`).
5. **De-projectize, classify, test, and publish or propose**: For `scope: "global"`, `checkDeprojectization` rejects any candidate carrying hardcoded user/home paths, project IDs, host IDs, project names/domains (outside `$inputs.*` placeholders), credential shapes, or `FORBIDDEN_GRANTS`, including project-specific `category` slugs or labels walked by `walkStrings` (`src/rooms/night-graphs/deprojectize.ts:71-106`). `classifyEvolutionDiff` compares the candidate against `latestPublishedSnapshot` or disk baseline and marks topology, permission, breaking-input, skill-removal, `category_changed`, or `new_v1` changes as `structural_or_new`, leaving skill additions, copy/check refinements, and optional inputs as `minor_patch` (`src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/deprojectize.ts:118-196`, `packages/workflow-engine/src/draft-store.ts:232-241`). Every candidate must pass `loadWorkflow` and all `runDraftTest` cases before mutating an existing published draft (`src/rooms/night-graphs/server/graph-evolve-graph.ts:203-220`):
   - `minor_patch` with a base definition auto-publishes via `architect.publish`, marks source deltas processed (`markTrajectoryDeltasProcessed`), and posts a non-waking `workflow_evolved_digest` owner item with a 1-click rollback action (`src/rooms/night-graphs/server/graph-evolve-graph.ts:231-250`).
   - `structural_or_new` or a new `v1` graph stays at `status: "tested"` and posts a waking `workflow_draft_proposed` owner item with a 1-click publish action (`src/rooms/night-graphs/server/graph-evolve-graph.ts:251-263`).
   - Any candidate failing de-projectization, `loadWorkflow`, or `runDraftTest` is rejected (`rejected_deprojectize`, `rejected_invalid`, `rejected_tests`) without mutating published drafts or retiring uncited deltas (`src/rooms/night-graphs/server/graph-evolve-graph.ts:186-220`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:266-269`).
6. **Persist process state and operate from Pilot panel**: `.agents/pilot/process-state.json` is validated by `pilotProcessStateSchema` and updated via `readPilotProcessStateCas` / `writePilotProcessStateCas` (`src/rooms/pilot-panel/process-state.ts:3-19`, `src/rooms/pilot-panel/process-state.ts:86-159`), with `formatProcessStatePromptLine` projecting the stage and approved baseline into prompt lines (`src/rooms/pilot-panel/process-state.ts:161-172`). `PilotProcessStateSection` and `PilotWorkflowDraftsSection` render the checkpoint and evolution drafts in the right panel (`src/rooms/pilot-panel/ui/process-state-section.tsx:5-65`, `src/rooms/pilot-panel/ui/workflow-drafts-section.tsx:21-96`), backed by `pilot_panel_publish_workflow_draft` and `pilot_panel_rollback_workflow_draft` (`src/rooms/pilot-panel/server/rpc.ts:73-76`, `src/rooms/pilot-panel/server/workflow-drafts.ts:130-188`).

## Trajectory crystallization, daily digestion, and skill intent

| Component | Responsibility | Source |
|---|---|---|
| `resolveSkillIntent` | Bilingual RU/EN stem and domain-synonym scoring against catalog items | `src/rooms/errands/skill-intent.ts:122-208` |
| `hasExplicitSkillIntent` | Detects explicit owner instructions to apply skills or rules via `EXPLICIT_INTENT_RE` | `src/rooms/errands/skill-intent.ts:61-116` |
| `episodeSkills` | Tracks `{ offered, read, used }` including un-offered `SKILL.md` reads | `src/rooms/errands/episode-enrich.ts:161-182` |
| `recordTrajectoryDelta` | Masks and deduplicates chat/run interventions in `lane_pilot_trajectory_delta` | `src/rooms/errands/trajectory-delta.ts:125-191` |
| `listUnprocessedTrajectoryDeltas` | Feeds unconsumed owner-accepted deltas to the nightly collector | `src/rooms/errands/trajectory-delta.ts:194-214` |
| `listPilotDayCandidates` | Queries 24h `lane_pilot_run`, Pilot-activated chats, and completed non-errand user workflows | `src/rooms/storage/analytics-store.ts:250-327` |
| `digestPilotDayDialogues` | Masks dialogues/outcomes, runs `episode-analyst`, writes deltas and `lane_pilot_day_digest` | `src/rooms/night-graphs/server/pilot-day-digest.ts:171-265` |
| `savePilotDayDigest` / `listPilotDayDigests` | Idempotently stores daily digests and supplies 14-day summaries to `collectGraphEvolveEvidence` | `src/rooms/storage/analytics-store.ts:330-356` |

## De-projectization gate and nightly evolution (`lp.graph-evolve-nightly`)

`lp.graph-evolve-nightly` wires `digest` (`lp.graph_evolve_digest`), `collect` (`lp.graph_evolve_collect`), `synthesize` (`lp.graph_evolve_synthesize`), and `apply` (`lp.graph_evolve_apply`) with an early `empty_done` exit when `collect.status == 'empty'` (`workflows/lp.graph-evolve-nightly.json:33-158`).

| Gate / Policy Rule | Outcome | Source |
|---|---|---|
| `checkDeprojectization` finding (`abs_path`, `project_id`, `host_id`, `project_name_or_domain`, `secret_shape`, `forbidden_grant`) | Candidate rejected (`rejected_deprojectize`) before draft creation | `src/rooms/night-graphs/deprojectize.ts:4-106`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:186-194` |
| `loadWorkflow` error or failing `runDraftTest` | Candidate rejected (`rejected_invalid` or `rejected_tests`) | `src/rooms/night-graphs/server/graph-evolve-graph.ts:203-220` |
| `classifyEvolutionDiff` returns `minor_patch` with `baseDef` | Auto-published via `architect.publish`; `workflow_evolved_digest` posted with rollback button | `src/rooms/night-graphs/deprojectize.ts:118-196`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:231-250` |
| `classifyEvolutionDiff` returns `structural_or_new` (including `category_changed`) or `new_v1` | Draft saved as `tested`; `workflow_draft_proposed` posted for owner approval | `src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/deprojectize.ts:187-196`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:251-263` |
| `listEvolutionDrafts` and `previousVersionSnapshot` | Powers panel draft listing and validated rollback to prior published version | `packages/workflow-engine/src/draft-store.ts:215-263`, `src/rooms/pilot-panel/server/workflow-drafts.ts:149-188` |

## Open bilingual dynamic graph categories (`category`)

`workflowSchema` and `normalizeWorkflow` (`packages/workflow-engine/src/schema.ts:23-26`, `packages/workflow-engine/src/schema.ts:275`, `packages/workflow-engine/src/schema.ts:447-450`) accept optional `category` (`slug` or `{ id, label: { en, ru } }`), while `validateWorkflow` (`packages/workflow-engine/src/validate.ts:78-80`) enforces `category_label_required` whenever `category.id` is outside the 9 built-in shelves (`WORKFLOW_CATEGORIES` in `src/rooms/workflow/categories.ts:5`).

- **Evolution and de-projectization**: `classifyEvolutionDiff` treats a `category.id` change on an existing published graph as `structural_or_new` (`category_changed` in `src/rooms/night-graphs/deprojectize.ts:33`, `src/rooms/night-graphs/deprojectize.ts:187-189`), and `checkDeprojectization` rejects project-specific category slugs/labels (`src/rooms/night-graphs/deprojectize.ts:71-106`). `synthesizeInIsolatedRoom` passes `collectKnownCategories` to the nightly synthesizer so newly crystallized domains receive their own universal bilingual category (`src/rooms/night-graphs/server/graph-evolve-graph.ts:274-316`).
- **Built-in example and UI/export surface**: `workflows/site-creation.json:29-35` declares `category: { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } }`, rendered as dedicated clusters, shelves, and filter chips across `src/rooms/workflow/ui/workflow-map.tsx:47-58` (deterministic `oklch` hues via `dynamicHue` / `catColor`), `src/rooms/workflow/ui/workflow-map.tsx:176-225`, `src/rooms/workflow/ui/workflow-map.tsx:550-577`, `src/rooms/workflow/ui/workflow-library-parts.tsx:28-64`, `src/rooms/workflow/ui/workflow-library-parts.tsx:96-131`, `src/rooms/workflow/ui/workflows.tsx:117-118`, `src/rooms/workflow/ui/workflows.tsx:242`, `src/rooms/workflow/ui/workflows.tsx:266-270`, and `src/rooms/workflow/workflow-export.ts:26-31`, `src/rooms/workflow/workflow-export.ts:61-77`, `src/rooms/workflow/workflow-export.ts:97-105`.

## Process state checkpoint and `site-creation` lifecycle

Both `lp.graph-evolve-nightly` and `site-creation` are registered as built-in workflows (`src/rooms/workflow/builtin.ts:54`, `src/rooms/workflow/builtin.ts:123`, `src/rooms/workflow/builtin.ts:196`, `src/rooms/workflow/builtin.ts:265`). In the workflow router, `site-creation` is included in `WRITES` and boosted for full website creation requests (`packages/workflow-engine/src/router.ts:172`, `packages/workflow-engine/src/router.ts:238-239`).

1. **Intake and adaptive branches**: `smart_intake` evaluates `goal`, `niche`, `references`, `facts_source`, `locale`, and `quality_mode`, setting `needs_brief` and `has_references` (`workflows/site-creation.json:47-132`). `ask_brief` is skipped when `smart_intake.needs_brief == false`, and `discover_references` runs competitor/reference research unless `smart_intake.has_references == true` (`workflows/site-creation.json:134-189`).
2. **Copy, visual concepts, and owner baseline lock**: `copy_and_structure` (`ru-text`, `karpathy-guidelines`) feeds `visual_concepts` (`impeccable-ui`, `design-taste`, `web-design`), which produces `baseline_path` and `baseline_sha256` for the `approve_direction` human gate (`workflows/site-creation.json:191-289`). Approval invokes `save_process_state` (`lp.save_process_state`), persisting `approvedDesignBaseline`, `stage`, and `activeSkills` via `writePilotProcessStateCas` (`workflows/site-creation.json:291-322`, `src/rooms/pilot-panel/server/workflow-drafts.ts:190-219`).
3. **Build and responsive browser verification**: `build_site` (`lp-task`) implements the site in an isolated worktree and hands off to `verify_browser` (`browser-qa`) at `375` and `1280` px viewports with a rework loop back to `build_site` before emitting `done`, `blocked`, or `aborted` (`workflows/site-creation.json:324-489`).

See [Everything is a graph](guide/graphs.md) for the workflow catalog and [Night policy](night-policy.md) for general night-loop boundaries.

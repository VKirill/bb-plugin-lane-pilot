---
title: "Trajectory crystallization, skill intent resolution, and nightly workflow evolution"
type: component
created: 2026-11-18
updated: 2026-11-18
status: active
confidence: high
tags: [workflows, evolution, night-graphs, skills, pilot-panel]
sources:
  - src/rooms/errands/skill-intent.ts
  - src/rooms/errands/episode-enrich.ts
  - src/rooms/errands/trajectory-delta.ts
  - packages/workflow-engine/src/draft-store.ts
  - src/rooms/night-graphs/deprojectize.ts
  - src/rooms/night-graphs/server/graph-evolve-graph.ts
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

TL;DR: Owner skill requests and trajectory corrections are resolved with bilingual RU/EN intent matching (`src/rooms/errands/skill-intent.ts:125-211`), stored masked in an append-only ledger (`src/rooms/errands/trajectory-delta.ts:16-45`, `src/rooms/errands/trajectory-delta.ts:151-217`), synthesized nightly in an isolated directory (`src/rooms/night-graphs/server/graph-evolve-graph.ts:224-260`), filtered for de-projectization (`src/rooms/night-graphs/deprojectize.ts:71-106`), and either auto-published on minor patches or queued for 1-click owner approval in the Pilot panel (`src/rooms/pilot-panel/server/workflow-drafts.ts:130-187`).

## How it works

1. **Resolve skill intent and record actual skill usage**: `hasExplicitSkillIntent` detects RU/EN skill-request phrasing via `EXPLICIT_INTENT_RE` (`src/rooms/errands/skill-intent.ts:61-119`), and `resolveSkillIntent` ranks catalog entries by normalized name hits, `stems` from `@lane-pilot/workflow-engine`, and `SKILL_DOMAIN_SYNONYMS` across `copywriting`, `seo`, `design`, `qa`, and `architecture` (`src/rooms/errands/skill-intent.ts:29-51`, `src/rooms/errands/skill-intent.ts:125-211`). During episode enrichment, `episodeSkills` combines offered skills with un-offered skills discovered via `skillReadsOf` (`*/SKILL.md` file reads) and `directSkillCallsOf` (`skill` tool calls), emitting `{ name, offered: false, read, used }` (`src/rooms/errands/episode-enrich.ts:123-182`).
2. **Capture masked trajectory deltas**: `recordTrajectoryDelta` validates `TRAJECTORY_INTERVENTION_KINDS` (`skill_request`, `rule_added`, `step_inserted`, `reference_branch`, `variant_selected`), passes `rawSummary` through `redactKnown`, `scrubQuote`, and `maskPii`, resolves explicit skills, and executes `INSERT OR IGNORE` into the append-only table `lane_pilot_trajectory_delta` protected by `lane_pilot_trajectory_delta_no_delete` (`src/rooms/errands/trajectory-delta.ts:16-45`, `src/rooms/errands/trajectory-delta.ts:151-217`).
3. **Collect and synthesize nightly in an isolated room**: Every day at `50 4 * * *` (`GRAPH_EVOLVE_CRON`), `mountGraphEvolveNightly` triggers `lp.graph-evolve-nightly` under daily idempotency key `wfTerminalByIdemKey` (`src/rooms/night-graphs/server/graph-evolve-graph.ts:17-19`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:296-308`). `collectGraphEvolveEvidence` aggregates unprocessed deltas from `listUnprocessedTrajectoryDeltas` and enriched episode clusters (`src/rooms/night-graphs/server/graph-evolve-graph.ts:61-97`). When `status` is `"ready"`, `synthesizeInIsolatedRoom` prepares `$HOME/.lane-pilot/graph-evolve` and calls `services.ruleScan.runAnalyzer` with only masked summaries (`src/rooms/night-graphs/server/graph-evolve-graph.ts:224-260`).
4. **De-projectize, classify, test, and publish or propose**: For `scope: "global"`, `checkDeprojectization` rejects any candidate carrying hardcoded user/home paths, project IDs, host IDs, project names/domains (outside `$inputs.*` placeholders), credential shapes, or `FORBIDDEN_GRANTS` (`src/rooms/night-graphs/deprojectize.ts:71-106`). `classifyEvolutionDiff` compares the candidate against `latestPublishedSnapshot` or disk baseline and marks topology, permission, breaking-input, skill-removal, or new-graph changes as `structural_or_new`, leaving skill additions, copy/check refinements, and optional inputs as `minor_patch` (`src/rooms/night-graphs/deprojectize.ts:118-193`, `packages/workflow-engine/src/draft-store.ts:232-249`). Every candidate must pass `loadWorkflow` and all `runDraftTest` cases (`src/rooms/night-graphs/server/graph-evolve-graph.ts:161-182`):
   - `minor_patch` with a base definition auto-publishes via `architect.publish`, marks source deltas processed (`markTrajectoryDeltasProcessed`), and posts a non-waking `workflow_evolved_digest` owner item with a 1-click rollback action (`src/rooms/night-graphs/server/graph-evolve-graph.ts:185-204`).
   - `structural_or_new` or a new `v1` graph stays at `status: "tested"` and posts a waking `workflow_draft_proposed` owner item with a 1-click publish action (`src/rooms/night-graphs/server/graph-evolve-graph.ts:205-217`).
   - Any candidate failing de-projectization, `loadWorkflow`, or `runDraftTest` is rejected (`rejected_deprojectize`, `rejected_invalid`, `rejected_tests`) and leaves unprocessed deltas untouched (`src/rooms/night-graphs/server/graph-evolve-graph.ts:144-182`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:220`).
5. **Persist process state and operate from Pilot panel**: `.agents/pilot/process-state.json` is validated by `pilotProcessStateSchema` and updated via `readPilotProcessStateCas` / `writePilotProcessStateCas` (`src/rooms/pilot-panel/process-state.ts:3-19`, `src/rooms/pilot-panel/process-state.ts:86-159`), with `formatProcessStatePromptLine` projecting the stage and approved baseline into prompt lines (`src/rooms/pilot-panel/process-state.ts:161-172`). `PilotProcessStateSection` and `PilotWorkflowDraftsSection` render the checkpoint and evolution drafts in the right panel (`src/rooms/pilot-panel/ui/process-state-section.tsx:5-65`, `src/rooms/pilot-panel/ui/workflow-drafts-section.tsx:21-96`), backed by `pilot_panel_publish_workflow_draft` and `pilot_panel_rollback_workflow_draft` (`src/rooms/pilot-panel/server/rpc.ts:73-76`, `src/rooms/pilot-panel/server/workflow-drafts.ts:130-187`).

## Trajectory crystallization and skill intent

| Component | Responsibility | Source |
|---|---|---|
| `resolveSkillIntent` | Bilingual RU/EN stem and domain-synonym scoring against catalog items | `src/rooms/errands/skill-intent.ts:125-211` |
| `hasExplicitSkillIntent` | Detects explicit owner instructions to apply skills or rules via `EXPLICIT_INTENT_RE` | `src/rooms/errands/skill-intent.ts:61-119` |
| `episodeSkills` | Tracks `{ offered, read, used }` including un-offered `SKILL.md` reads | `src/rooms/errands/episode-enrich.ts:161-182` |
| `recordTrajectoryDelta` | Masks and deduplicates chat/run interventions in `lane_pilot_trajectory_delta` | `src/rooms/errands/trajectory-delta.ts:151-217` |
| `listUnprocessedTrajectoryDeltas` | Feeds unconsumed owner-accepted deltas to the nightly collector | `src/rooms/errands/trajectory-delta.ts:220-240` |

## De-projectization gate and nightly evolution (`lp.graph-evolve-nightly`)

`lp.graph-evolve-nightly` wires `collect` (`lp.graph_evolve_collect`), `synthesize` (`lp.graph_evolve_synthesize`), and `apply` (`lp.graph_evolve_apply`) with an early `empty_done` exit when `collect.status == 'empty'` (`workflows/lp.graph-evolve-nightly.json:33-134`).

| Gate / Policy Rule | Outcome | Source |
|---|---|---|
| `checkDeprojectization` finding (`abs_path`, `project_id`, `host_id`, `project_name_or_domain`, `secret_shape`, `forbidden_grant`) | Candidate rejected (`rejected_deprojectize`) before draft creation | `src/rooms/night-graphs/deprojectize.ts:4-106`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:144-151` |
| `loadWorkflow` error or failing `runDraftTest` | Candidate rejected (`rejected_invalid` or `rejected_tests`) | `src/rooms/night-graphs/server/graph-evolve-graph.ts:161-182` |
| `classifyEvolutionDiff` returns `minor_patch` with `baseDef` | Auto-published via `architect.publish`; `workflow_evolved_digest` posted with rollback button | `src/rooms/night-graphs/deprojectize.ts:118-193`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:185-204` |
| `classifyEvolutionDiff` returns `structural_or_new` or `new_v1` | Draft saved as `tested`; `workflow_draft_proposed` posted for owner approval | `src/rooms/night-graphs/deprojectize.ts:33-128`, `src/rooms/night-graphs/server/graph-evolve-graph.ts:205-217` |
| `listEvolutionDrafts` and `previousVersionSnapshot` | Powers panel draft listing and validated rollback to prior version | `packages/workflow-engine/src/draft-store.ts:215-257`, `src/rooms/pilot-panel/server/workflow-drafts.ts:149-187` |

## Process state checkpoint and `site-creation` lifecycle

Both `lp.graph-evolve-nightly` and `site-creation` are registered as built-in workflows (`src/rooms/workflow/builtin.ts:54`, `src/rooms/workflow/builtin.ts:123`, `src/rooms/workflow/builtin.ts:196`, `src/rooms/workflow/builtin.ts:265`). In the workflow router, `site-creation` is included in `WRITES` and boosted for full website creation requests (`packages/workflow-engine/src/router.ts:172`, `packages/workflow-engine/src/router.ts:238-239`).

1. **Intake and adaptive branches**: `smart_intake` evaluates `goal`, `niche`, `references`, `facts_source`, `locale`, and `quality_mode`, setting `needs_brief` and `has_references` (`workflows/site-creation.json:40-125`). `ask_brief` is skipped when `smart_intake.needs_brief == false`, and `discover_references` runs competitor/reference research unless `smart_intake.has_references == true` (`workflows/site-creation.json:127-182`).
2. **Copy, visual concepts, and owner baseline lock**: `copy_and_structure` (`ru-text`, `karpathy-guidelines`) feeds `visual_concepts` (`impeccable-ui`, `design-taste`, `web-design`), which produces `baseline_path` and `baseline_sha256` for the `approve_direction` human gate (`workflows/site-creation.json:184-282`). Approval invokes `save_process_state` (`lp.save_process_state`), persisting `approvedDesignBaseline`, `stage`, and `activeSkills` via `writePilotProcessStateCas` (`workflows/site-creation.json:284-315`, `src/rooms/pilot-panel/server/workflow-drafts.ts:189-218`).
3. **Build and responsive browser verification**: `build_site` (`lp-task`) implements the site in an isolated worktree and hands off to `verify_browser` (`browser-qa`) at `375` and `1280` px viewports with a rework loop back to `build_site` before emitting `done`, `blocked`, or `aborted` (`workflows/site-creation.json:317-482`).

See [Everything is a graph](guide/graphs.md) for the workflow catalog and [Night policy](night-policy.md) for general night-loop boundaries.

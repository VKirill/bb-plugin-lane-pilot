// Public API of night-graphs/server: the night jobs of Lane Pilot as graph steps. Each job keeps its planning and its judging in its own room;
// this room wires the model work of them onto the workflow engine (one mount per graph), so a plugin start registers every executor before a run resumes.

import type { ServerCore } from "../../contracts/server";
import { mountCriticEditGraph } from "./critic-edit-graph";
import { mountEpisodesGraph } from "./episodes-graph";
import { mountGraphEvolveNightly } from "./graph-evolve-graph";


import type { BenchApi } from "../../bench/service";
import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { HarnessApi } from "../../harness/server/harness";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { WallGraphApi, WorkflowEngineApi, WorkflowTriggersApi, WriterHostApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  bench: BenchApi;
  docsPlaces: DocsNightlyApi["docsPlaces"];
  harness: HarnessApi;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: RuleScanApi;
  wall: WallGraphApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
}
export { analystPlace, episodeSweepDeps } from "./episodes-graph";
export {
  GRAPH_EVOLVE_CRON,
  GRAPH_EVOLVE_SCHEDULE,
  GRAPH_EVOLVE_WORKFLOW,
  applyGraphEvolveCandidates,
  collectGraphEvolveEvidence,
  mountGraphEvolveNightly,
  validateEvolveSuiteCandidates,
  type GraphEvolveCandidate,
  type GraphEvolveCollectSummary,
  type GraphEvolveDeps,
  type GraphEvolveOutcome,
} from "./graph-evolve-graph";
export { extractSubworkflowRefs, topologicalSortSuite } from "./graph-evolve-suite";
export {
  auditSynthesizedSuite,
  createLiveEvolveRoleRunner,
  critiqueEvolutionBlueprint,
  planEvolutionBlueprint,
  synthesizeSuiteAndSkillsFromBlueprint,
  synthesizeSuiteFromBlueprint,
  type EvolveCatalogContext,
  type EvolveReviewVerdict,
  type EvolveRole,
  type EvolveRoleRunner,
  type ExistingGlobalWorkflowSummary,
  type ProcessBlueprint,
  type ProcessBlueprintGraphSpec,
  type ProcessBlueprintStageSpec,
  type SynthesizeSuiteResult,
} from "./graph-evolve-pipeline";
export {
  createLivePilotDayDigestDeps,
  digestPilotDayDialogues,
  loadDigestSkillCatalog,
  type PilotDayDigestDeps,
  type PilotDayDigestSummary,
} from "./pilot-day-digest";
import { mountHarnessGraph } from "./harness-graph";
import { mountRulesScanGraph } from "./rules-scan-graph";
import { mountWallHuntGraph } from "./wall-hunt-graph";

export function mountNightGraphs(ctx: ServerCore, services: Services): void {
  mountRulesScanGraph(ctx, services);
  mountWallHuntGraph(ctx, services);
  mountHarnessGraph(ctx, services);
  mountCriticEditGraph(ctx, services);
  mountEpisodesGraph(ctx, services);
  mountGraphEvolveNightly(ctx, services);
}

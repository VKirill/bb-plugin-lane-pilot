// Public API of night-graphs/server: the night jobs of Lane Pilot as graph steps. Each job keeps its planning and its judging in its own room;
// this room wires the model work of them onto the workflow engine (one mount per graph), so a plugin start registers every executor before a run resumes.

import type { ServerCore } from "../../contracts/server";
import { mountCriticEditGraph } from "./critic-edit-graph";
import { mountEpisodesGraph } from "./episodes-graph";


import type { BenchApi } from "../../bench/service";
import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { HarnessApi } from "../../harness/server/harness";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { WallGraphApi, WorkflowEngineApi, WriterHostApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  bench: BenchApi;
  docsPlaces: DocsNightlyApi["docsPlaces"];
  harness: HarnessApi;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: RuleScanApi;
  wall: WallGraphApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}
export { analystPlace, episodeSweepDeps } from "./episodes-graph";
import { mountHarnessGraph } from "./harness-graph";
import { mountJevLabelsGraph } from "./jev-labels-graph";
import { mountModelRebenchGraph } from "./model-rebench-graph";
import { mountRulesScanGraph } from "./rules-scan-graph";
import { mountWallHuntGraph } from "./wall-hunt-graph";

export function mountNightGraphs(ctx: ServerCore, services: Services): void {
  mountRulesScanGraph(ctx, services);
  mountWallHuntGraph(ctx, services);
  mountHarnessGraph(ctx, services);
  mountCriticEditGraph(ctx, services);
  mountModelRebenchGraph(ctx, services);
  mountJevLabelsGraph(ctx, services);
  mountEpisodesGraph(ctx, services);
}
export {
  evaluateModelRouting,
  modelRebenchMorningLine,
  latestModelRebenchSummary,
  saveModelRebenchResult,
  mountModelRebenchGraph,
  MODEL_REBENCH_WORKFLOW,
  MODEL_REBENCH_SCHEDULE,
  type ModelRebenchMetrics,
} from "./model-rebench-graph";

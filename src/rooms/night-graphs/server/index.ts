// Public API of night-graphs/server: the night jobs of Lane Pilot as graph steps. Each job keeps its planning and its judging in its own room;
// this room wires the model work of them onto the workflow engine (one mount per graph), so a plugin start registers every executor before a run resumes.
import type { ServerCore, Services } from "../../core/server";
import { mountHarnessGraph } from "./harness-graph";
import { mountRulesScanGraph } from "./rules-scan-graph";
import { mountWallHuntGraph } from "./wall-hunt-graph";

export function mountNightGraphs(ctx: ServerCore, services: Services): void {
  mountRulesScanGraph(ctx, services);
  mountWallHuntGraph(ctx, services);
  mountHarnessGraph(ctx, services);
}

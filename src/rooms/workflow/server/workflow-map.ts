import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import type { StoredWorkflow, WorkflowStore } from "@lane-pilot/workflow-engine";
import type { WorkflowNode } from "@lane-pilot/workflow-engine";
import { workflowCategory } from "../categories";

type MapOutput = z.infer<typeof rpcContract.workflow_map.output>;
export type WorkflowMapData = Omit<MapOutput, "project">;
export type MapStats = Pick<MapOutput["graphs"][number], "runs30d" | "successRate">;

const PROMPT_LIMIT = 200;

/** The role a step names: an agent's own, a human's (usually "owner"); the other types have none. */
const roleOf = (node: WorkflowNode): string | null =>
  node.type === "agent" || node.type === "human" ? (node.role ?? null) : null;

/** The skills a step runs with: its own list plus its profile's (an agent's declared skill set). */
const skillsOf = (node: WorkflowNode): string[] => {
  const own = node.type === "agent" ? node.skills : [];
  const profile = "profile" in node ? (node.profile?.skills ?? []) : [];
  return [...new Set([...own, ...profile])];
};

const promptOf = (node: WorkflowNode): string | null => {
  const text = node.type === "agent" ? node.prompt : node.type === "human" ? node.question : null;
  return text ? text.slice(0, PROMPT_LIMIT) : null;
};

/**
 * The workflow library as one map: every graph on a shelf of its category, its steps and edges, and the calls between
 * graphs (a `subworkflow` node, or a `parallel` node whose branch is one). Notes are not steps; edges keep their
 * `start`/`end` ends. `statsOf` gives a graph's run counters (the library's own stats function).
 */
export function buildWorkflowMap(items: StoredWorkflow[], statsOf: (workflowId: string) => MapStats, commit: string | null): WorkflowMapData {
  const graphs: WorkflowMapData["graphs"] = [];
  const steps: WorkflowMapData["steps"] = [];
  const edges: WorkflowMapData["edges"] = [];
  const calls: WorkflowMapData["calls"] = [];

  for (const item of items) {
    const { workflow } = item;
    graphs.push({
      id: workflow.id, name: workflow.name, category: workflowCategory(workflow), tags: workflow.tags,
      scope: item.origin, status: workflow.status,
      ...statsOf(workflow.id),
    });
    for (const node of workflow.nodes) {
      if (node.type === "note") continue;
      steps.push({ graph: workflow.id, id: node.id, type: node.type, title: node.title ?? null, role: roleOf(node), skills: skillsOf(node), prompt: promptOf(node) });
      if (node.type === "subworkflow") calls.push({ fromGraph: workflow.id, fromStep: node.id, toGraph: node.workflow });
      if (node.type === "parallel" && node.child?.type === "subworkflow") calls.push({ fromGraph: workflow.id, fromStep: node.id, toGraph: node.child.workflow });
    }
    for (const edge of workflow.edges) edges.push({ graph: workflow.id, from: edge.from, to: edge.to });
  }

  return { commit, generatedAt: Date.now(), graphs, steps, edges, calls };
}

/** The map over a loaded store (the library's `loadStore`), so built-in, global and project files all land in it. */
export async function workflowMapFromStore(store: WorkflowStore, statsOf: (workflowId: string) => MapStats, commit: string | null): Promise<WorkflowMapData> {
  return buildWorkflowMap(store.list(), statsOf, commit);
}

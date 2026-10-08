import type { z } from "zod";
import type { rpcContract } from "../../../contracts";

export type RunSnapshot = NonNullable<z.infer<(typeof rpcContract)["workflow_run_snapshot"]["output"]>["snapshot"]>;
export type RunStep = RunSnapshot["steps"][number];
export type NodeStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";
/** What a node shows during a run: one status for all its steps (visits, branches) and the steps themselves for the detail view. */
export type NodeRun = { status: NodeStatus; visits: number; steps: RunStep[] };

const STATE_STATUS: Record<string, NodeStatus> = {
  pending: "pending", running: "running", waiting: "waiting", succeeded: "done", skipped: "skipped",
  failed: "failed", interrupted: "failed", canceled: "failed",
};
export const stepStatus = (state: string): NodeStatus => STATE_STATUS[state] ?? "pending";

/** One status for a node that may have several steps: what is moving or broken wins, then done, then skipped. */
function combine(steps: RunStep[]): NodeStatus {
  const all = steps.map((step) => stepStatus(step.state));
  for (const wanted of ["running", "waiting", "failed"] as const) if (all.includes(wanted)) return wanted;
  if (all.every((status) => status === "skipped")) return "skipped";
  if (all.includes("pending")) return all.includes("done") ? "running" : "pending";
  return "done";
}

/**
 * The statuses of a run's nodes by canvas key (`prefix` is the key of the expanded subworkflow node the run belongs to),
 * and the edges its steps came in on. A node with no step has not been reached: pending.
 */
export function runView(snapshot: RunSnapshot, prefix = ""): { runs: Map<string, NodeRun>; edges: Set<string> } {
  const key = (id: string) => (prefix ? `${prefix}/${id}` : id);
  const byNode = new Map<string, RunStep[]>();
  for (const step of snapshot.steps) byNode.set(step.nodeId, [...(byNode.get(step.nodeId) ?? []), step]);
  const runs = new Map<string, NodeRun>();
  for (const node of snapshot.graph.nodes) {
    const steps = byNode.get(node.id) ?? [];
    if (node.kind === "start") { runs.set(key(node.id), { status: "done", visits: 0, steps }); continue; }
    if (node.kind === "end") {
      const finished = ["succeeded"].includes(snapshot.run.status), stopped = ["failed", "blocked", "interrupted", "canceled"].includes(snapshot.run.status);
      runs.set(key(node.id), { status: finished ? "done" : stopped ? "failed" : "pending", visits: 0, steps }); continue;
    }
    runs.set(key(node.id), { status: steps.length ? combine(steps) : "pending", visits: steps.length, steps });
  }
  const edges = new Set<string>();
  for (const step of snapshot.steps) if (step.edgeIndex !== null) edges.add(key(`e${step.edgeIndex}`));
  // The exit has no step of its own: an edge into it was taken when its source finished.
  for (const edge of snapshot.graph.edges) if (edge.to === "$end" && snapshot.run.status === "succeeded" && runs.get(key(edge.from))?.status === "done") edges.add(key(`e${edge.index}`));
  return { runs, edges };
}

/** The most useful run to open: one still going, else the latest. */
export function pickRun<T extends { id: string; status: string }>(runs: T[]): T | null {
  return runs.find((run) => run.status === "running" || run.status === "waiting") ?? runs[0] ?? null;
}

import { MAX_SUBWORKFLOW_DEPTH } from "./schema";
import type { Workflow } from "./schema";
import type { ResolveWorkflow } from "./lower";

/** The child definitions a run was started with, by workflow id (and `@version` when the node names one). */
export type Pins = Record<string, Workflow>;
export const pinKey = (id: string, version?: number) => (version === undefined ? id : `${id}@${version}`);

/** Every child a workflow reaches, resolved once: a running chain keeps them although the catalog changes (2026-10-29 audit A-011). */
export function collectPins(workflow: Workflow, resolve: ResolveWorkflow, out: Pins = {}, depth = 0): Pins {
  for (const node of workflow.nodes) {
    if (node.type !== "subworkflow") continue;
    const key = pinKey(node.workflow, node.version);
    if (out[key]) continue;
    const child = resolve(node.workflow, node.version);
    if (!child) continue;
    out[key] = child;
    if (depth < MAX_SUBWORKFLOW_DEPTH) collectPins(child, resolve, out, depth + 1);
  }
  return out;
}

import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { createWorkflowLibrary } from "../workflow-library";
import { realDeps } from "../workflow-architect";
import { createWorkflowOps } from "../workflow-ops";
import { createWorkflowPreflight } from "../workflow-preflight";

/** The Workflows tab's actions on a workflow: its run history, re-running one node, a dry run, the tests of a file. */
export function workflowOpsRpc(ctx: ServerCore, services: Services) {
  const ops = createWorkflowOps(ctx, services, createWorkflowLibrary(ctx, services), { preflight: createWorkflowPreflight(ctx, realDeps(ctx, services)) });
  return {
    workflow_runs: (input) => ops.runs(input),
    workflow_rerun_node: (input) => ops.rerunNode(input),
    workflow_preflight: (input) => ops.preflight(input),
    workflow_run: async (input) => {
      const result = await services.workflowTriggers.start({ projectId: input.projectId, workflowId: input.id, inputs: input.inputs, source: input.source, liveTrial: input.liveTrial });
      return result.ok ? { ok: true, runId: result.runId, created: result.created, status: result.status, notChecked: result.notChecked }
        : { ok: false, reason: result.reason, message: result.message, ...(result.missing ? { missing: result.missing } : {}), ...(result.issues ? { issues: result.issues } : {}), ...(result.envRequests ? { envRequests: result.envRequests } : {}) };
    },
    workflow_dry_run: (input) => ops.dryRun(input),
    workflow_run_tests: (input) => ops.runTests(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_runs" | "workflow_rerun_node" | "workflow_preflight" | "workflow_run" | "workflow_dry_run" | "workflow_run_tests">;
}

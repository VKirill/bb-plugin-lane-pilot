import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { createWorkflowLibrary } from "../workflow-library";
import { createWorkflowOps } from "../workflow-ops";

/** The Workflows tab's actions on a workflow: its run history, re-running one node, a dry run, the tests of a file. */
export function workflowOpsRpc(ctx: ServerCore, services: Services) {
  const ops = createWorkflowOps(ctx, services, createWorkflowLibrary(ctx, services));
  return {
    workflow_runs: (input) => ops.runs(input),
    workflow_rerun_node: (input) => ops.rerunNode(input),
    workflow_dry_run: (input) => ops.dryRun(input),
    workflow_run_tests: (input) => ops.runTests(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_runs" | "workflow_rerun_node" | "workflow_dry_run" | "workflow_run_tests">;
}

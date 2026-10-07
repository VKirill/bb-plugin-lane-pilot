import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { createWorkflowLibrary } from "../workflow-library";

/** The Workflows screens' reads: the library, one workflow with its graph, one run as a live view. */
export function workflowsRpc(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  return {
    workflow_list: ({ projectId }) => library.list({ projectId }),
    workflow_get: ({ id, projectId }) => library.get({ id, projectId }),
    workflow_run_snapshot: ({ runId }) => library.runSnapshot({ runId }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_list" | "workflow_get" | "workflow_run_snapshot">;
}

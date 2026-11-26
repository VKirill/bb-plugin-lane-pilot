import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../contracts/server";

import { buildWorkflowExport } from "../../../models/workflow-export";
import { createWorkflowLibrary } from "../../services/workflow-library";
import packageJson from "../../../../../../package.json";

import type { DocsApi } from "../../../../docs/server";
import type { WorkflowEngineApi } from "../../services/workflow";
import type { WorkflowTriggersApi } from "../../services/workflow-triggers-live";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsPlaces: DocsApi["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

/** «Выгрузить графы»: the same definitions the library loads, packed for a zip or a markdown sheet. */
export function workflowExportRpc(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  return {
    workflow_export: async (input) => {
      const entries = await library.exportEntries(input.projectId);
      return buildWorkflowExport({
        entries, ids: input.ids, category: input.category, includeProjectGraphs: input.includeProjectGraphs, redact: input.redact,
        version: packageJson.version, commit: process.env.LANE_PILOT_COMMIT ?? null,
      });
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_export">;
}

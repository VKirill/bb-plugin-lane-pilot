import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";

import { BUILTIN_SOURCES } from "../../../platform/server";
import { buildWorkflowExport, type WorkflowExportEntry } from "../../workflow-export";
import { createWorkflowLibrary } from "../workflow-library";
import packageJson from "../../../../../package.json";


import type { DocsNightlyApi } from "../../../docs/server/docs-nightly";
import type { WorkflowEngineApi } from "../workflow";
import type { WorkflowTriggersApi } from "../workflow-triggers-live";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsPlaces: DocsNightlyApi["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

/** «Выгрузить графы»: the same definitions the library loads, packed for a zip or a markdown sheet. */
export function workflowExportRpc(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  return {
    workflow_export: async (input) => {
      const { store, files } = await library.loadStore(input.projectId);
      const entries: WorkflowExportEntry[] = [];
      for (const item of store.list()) {
        let definition: unknown = null;
        if (item.origin === "builtin") definition = BUILTIN_SOURCES.find((source) => source.name === item.source)?.value ?? null;
        else {
          try { definition = JSON.parse(await files.read(item.source)); } catch { definition = null; }
        }
        entries.push({ definition: (definition ?? item.workflow) as Record<string, unknown>, workflow: item.workflow, scope: item.origin });
      }
      return buildWorkflowExport({
        entries, ids: input.ids, category: input.category, includeProjectGraphs: input.includeProjectGraphs, redact: input.redact,
        version: packageJson.version, commit: process.env.LANE_PILOT_COMMIT ?? null,
      });
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_export">;
}

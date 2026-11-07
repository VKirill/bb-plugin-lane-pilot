import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { Services } from "../../../core/server";
import { BUILTIN_SOURCES } from "../../builtin";
import { buildWorkflowExport, type WorkflowExportEntry } from "../../workflow-export";
import { createWorkflowLibrary } from "../workflow-library";
import packageJson from "../../../../../package.json";

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

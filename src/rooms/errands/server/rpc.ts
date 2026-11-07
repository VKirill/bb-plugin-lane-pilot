import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { rpcContract } from "../../contracts";

import type { ServerCore } from "../../contracts/server";
import { errandsDiagnosis } from "../diagnosis";
import { kindsOverview, listErrands } from "../logic";

import type { WorkflowEngineApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
}

/** The «Errands» page reads one call: the kinds (model in force at the global level, the period's counts) and the period's errand runs. */
export function errandsRpc(ctx: ServerCore, services: Services) {
  return {
    errands_overview: async ({ days, kind, projectId, limit }) => {
      const window = days ?? 7;
      const settings = (await ctx.effectiveProjectSettings(GLOBAL_SETTINGS_PROJECT_ID)).values;
      return { days: window, kinds: kindsOverview(ctx.db, settings, window), errands: listErrands(ctx.db, { days: window, kind, projectId, limit }) };
    },
    errands_diagnosis: async ({ days, projectId }) => {
      const store = await services.workflowCatalog.store();
      return errandsDiagnosis(ctx.db, { days: days ?? 7, projectId }, { workflows: store.list() });
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "errands_overview" | "errands_diagnosis">;
}

import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { rpcContract } from "../../contracts";
import type { ServerCore } from "../../core/server";
import { kindsOverview, listErrands } from "../logic";

/** The «Errands» page reads one call: the kinds (model in force at the global level, the period's counts) and the period's errand runs. */
export function errandsRpc(ctx: ServerCore) {
  return {
    errands_overview: async ({ days, kind, projectId, limit }) => {
      const window = days ?? 7;
      const settings = (await ctx.effectiveProjectSettings(GLOBAL_SETTINGS_PROJECT_ID)).values;
      return { days: window, kinds: kindsOverview(ctx.db, settings, window), errands: listErrands(ctx.db, { days: window, kind, projectId, limit }) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "errands_overview">;
}

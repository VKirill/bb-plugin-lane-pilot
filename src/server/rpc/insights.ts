import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { routingHint, writerAcceptanceStats } from "@lane-pilot/run-insights";
import { rpcContract } from "../../contracts";
import { loadProjectSettings } from "../../database";
import { configuredSetting } from "../context";
import type { ServerCore } from "../core";

const RISKS = ["low", "medium", "high", "critical"] as const;

/** What the settings screen shows next to the writer picker: first-try acceptance per risk against the configured pair. */
export function insightsRpc(ctx: ServerCore) {
  const { db } = ctx;
  return {
    get_routing_hint: async ({ projectId, days }) => {
      const stats = writerAcceptanceStats(db, { projectId, since: Date.now() - (days ?? 90) * 86_400_000 });
      const settings = loadProjectSettings(db, projectId);
      const provider = configuredSetting(settings, "writer.provider");
      const model = configuredSetting(settings, "writer.model");
      const current = typeof provider === "string" && typeof model === "string" && provider && model ? { providerId: provider, model } : null;
      const hints = RISKS.map((risk) => ({ risk, hint: routingHint(stats, current, risk) })).filter((row) => row.hint);
      return { current, hints, stats: stats.map((row) => ({ ...row })) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_routing_hint">;
}

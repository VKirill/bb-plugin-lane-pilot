import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SpentProbe } from "@lane-pilot/models";
import { seenProviderLimit, spawnUsageOf, warmSpawnUsage } from "../../../platform/server";
/** Whether a provider's usage window is nearly spent, read from the cache the writers share (a bounded warm-up first); undefined without a usage source. */
export async function limitProbe(bb: BbPluginApi, hostId: string, settings: Record<string, unknown>): Promise<SpentProbe | undefined> {
  const usage = spawnUsageOf({ bb });
  // No usage reader on this instance: what this instance saw itself (a limit in an answer, a thread that would not start) still moves the pick.
  if (!usage) return (providerId, model) => seenProviderLimit(bb, providerId, model);
  await warmSpawnUsage(usage, hostId);
  return (providerId, model) => usage.peek({ providerId, model, hostId, settings });
}


/** One log line per limit move of a stage's model. */
export const logLimitMove = (bb: BbPluginApi, what: string, issues: readonly string[] | undefined) => {
  for (const issue of issues ?? []) bb.log.info(`${what}: ${issue}`);
};

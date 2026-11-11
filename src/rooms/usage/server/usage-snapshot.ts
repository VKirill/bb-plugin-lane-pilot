import type { ServerCore } from "../../contracts/server";
import { hostContract } from "../../contracts";
import { listQaHosts, scheduleIsolated } from "../../platform/server";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadProjectSettings } from "../../storage";
import { DEFAULT_USAGE_SKIP_PERCENT, USAGE_SKIP_KEY, type ProviderUsage } from "./provider-usage";

/**
 * The session guard's spend facts (SMA k_hs_spend): every fifteen minutes each connected machine gets
 * ~/.lane-pilot/usage-snapshot.json with the subscription windows the usage source last measured and whether
 * the spend ceiling is a human's (`usage.skip_percent` set) or the default. The guard's spend stream and its
 * Task cap read this file; a machine that does not answer keeps its old snapshot — stale is a fact, not a failure.
 */
export const USAGE_SNAPSHOT_SCHEDULE = "usage-snapshot-push";
/** The subscription whose windows a lane session's spend is: the provider of the session itself. */
export const SNAPSHOT_PROVIDER = "claude-code";

export function mountUsageSnapshots(ctx: ServerCore, providerUsage?: Pick<ProviderUsage, "windows">): void {
  const host = () => ctx.bb.hosts.experimental_client({ contract: hostContract });
  const push = async () => {
    const settings = loadProjectSettings(ctx.db as never, GLOBAL_SETTINGS_PROJECT_ID) as Record<string, unknown>;
    const raw = settings[USAGE_SKIP_KEY];
    const skipSetByHuman = raw !== undefined && raw !== null && raw !== "";
    const skipPercent = skipSetByHuman && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_USAGE_SKIP_PERCENT;
    const hosts = (await listQaHosts(ctx.bb)).filter((row) => row.connected);
    for (const row of hosts) {
      try {
        const board = providerUsage ? await providerUsage.windows({ providerId: SNAPSHOT_PROVIDER, hostId: row.id }) : { at: null, windows: {} };
        const windows = Object.entries(board.windows).map(([label, w]) => ({ label, usedPercent: w.utilization, resetsAt: w.resetsAt }));
        await host().call("writeUsageSnapshot", {
          requestedHostId: row.id,
          snapshot: { at: new Date().toISOString(), windows, skipPercent, skipSetByHuman },
        }, { hostId: row.id, timeoutMs: 10_000 });
      } catch { /* a machine that does not answer keeps its old snapshot */ }
    }
  };
  scheduleIsolated(ctx.bb, USAGE_SNAPSHOT_SCHEDULE, "4,19,34,49 * * * *", async () => { await push(); }, { timeoutMs: 120_000 });
}

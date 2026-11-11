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
/** Machines asked at one time. */
export const SNAPSHOT_CONCURRENCY = 4;
/** An unchanged reading is written again after this long, so the guard's age check (SNAPSHOT_MAX_AGE_MS) stays met on a live machine. */
export const SNAPSHOT_HEARTBEAT_MS = 60 * 60_000;

/** `usage.skip_percent` set by a person to a number above 0 is a cap; unset or 0 (off) is not. */
export function humanSkip(raw: unknown): { skipSetByHuman: boolean; skipPercent: number } {
  const set = raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw));
  return { skipSetByHuman: set && Number(raw) > 0, skipPercent: set ? Number(raw) : DEFAULT_USAGE_SKIP_PERCENT };
}

export function mountUsageSnapshots(ctx: ServerCore, providerUsage?: Pick<ProviderUsage, "readings">): void {
  const host = () => ctx.bb.hosts.experimental_client({ contract: hostContract });
  const last = new Map<string, { key: string; at: number }>();
  const push = async () => {
    if (!providerUsage) return;
    const settings = loadProjectSettings(ctx.db as never, GLOBAL_SETTINGS_PROJECT_ID) as Record<string, unknown>;
    const { skipSetByHuman, skipPercent } = humanSkip(settings[USAGE_SKIP_KEY]);
    const hosts = (await listQaHosts(ctx.bb)).filter((row) => row.connected);
    for (let i = 0; i < hosts.length; i += SNAPSHOT_CONCURRENCY) {
      const batch = hosts.slice(i, i + SNAPSHOT_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (row) => {
        // `at` is when the usage source measured the figure again just now; a reading nothing answered for writes nothing.
        const reading = await providerUsage.readings({ providerId: SNAPSHOT_PROVIDER, hostId: row.id });
        if (!reading.measuredAt) return;
        const key = JSON.stringify([reading.windows, skipPercent, skipSetByHuman]);
        const before = last.get(row.id);
        if (before && before.key === key && Date.now() - before.at < SNAPSHOT_HEARTBEAT_MS) return;
        await host().call("writeUsageSnapshot", {
          requestedHostId: row.id,
          snapshot: { at: reading.measuredAt, windows: reading.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, model: w.model })), skipPercent, skipSetByHuman },
        }, { hostId: row.id, timeoutMs: 10_000 });
        last.set(row.id, { key, at: Date.now() });
      }));
      results.forEach((result, index) => {
        if (result.status === "rejected") ctx.bb.log.warn(`Lane Pilot usage snapshot: machine ${batch[index]!.id} did not take it (${result.reason instanceof Error ? result.reason.message : String(result.reason)}); it keeps its old snapshot`);
      });
    }
  };
  // A pass never throws: a failed read of the hosts or settings is one log line, the next pass tries again.
  scheduleIsolated(ctx.bb, USAGE_SNAPSHOT_SCHEDULE, "4,19,34,49 * * * *", async () => {
    try { await push(); }
    catch (cause) { ctx.bb.log.warn(`Lane Pilot usage snapshot pass failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }, { timeoutMs: 120_000 });
}

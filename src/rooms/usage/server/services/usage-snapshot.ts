import type { ServerCore } from "../../../contracts/server";
import { hostContract } from "../../../contracts";
import { listQaHosts } from "../../../platform/server";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadProjectSettings } from "../../../storage";
import { USAGE_SKIP_KEY } from "../../settings";
import { SNAPSHOT_CONCURRENCY, SNAPSHOT_HEARTBEAT_MS, SNAPSHOT_PROVIDER, humanSkip } from "../../models/usage-snapshot";
import type { ProviderUsage } from "./provider-usage";

/**
 * Pushes ~/.lane-pilot/usage-snapshot.json to connected hosts whenever usage readings or the human spend cap change,
 * coalescing concurrent triggers so at most one pass is in flight at a time.
 */
export function createUsageSnapshotPusher(
  ctx: Pick<ServerCore, "bb" | "db"> & Partial<Pick<ServerCore, "isDisposed" | "log">>,
  providerUsage?: Pick<ProviderUsage, "readings">,
): {
  push: (targetHostIds?: readonly string[]) => Promise<void>;
  forgetHost: (hostId: string) => void;
} {
  const host = () => ctx.bb.hosts.experimental_client({ contract: hostContract });
  const last = new Map<string, { key: string; at: number }>();
  let inflight: Promise<void> | null = null;
  let dirty = false;

  const writeHosts = async (targetHostIds?: readonly string[]) => {
    if (!providerUsage || ctx.isDisposed?.()) return;
    const settings = loadProjectSettings(ctx.db as never, GLOBAL_SETTINGS_PROJECT_ID) as Record<string, unknown>;
    const { skipSetByHuman, skipPercent } = humanSkip(settings[USAGE_SKIP_KEY]);
    const targetSet = targetHostIds?.length ? new Set(targetHostIds) : null;
    const hosts = (await listQaHosts(ctx.bb)).filter((row) => row.connected && (!targetSet || targetSet.has(row.id)));
    for (let i = 0; i < hosts.length; i += SNAPSHOT_CONCURRENCY) {
      if (ctx.isDisposed?.()) return;
      const batch = hosts.slice(i, i + SNAPSHOT_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (row) => {
        // `at` is when the usage source measured the figure again just now; a reading nothing answered for writes nothing.
        const reading = await providerUsage.readings({ providerId: SNAPSHOT_PROVIDER, hostId: row.id });
        if (!reading.measuredAt || ctx.isDisposed?.()) return;
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
        if (result.status === "rejected") ctx.bb.log?.warn?.(`Lane Pilot usage snapshot: machine ${batch[index]!.id} did not take it (${result.reason instanceof Error ? result.reason.message : String(result.reason)}); it keeps its old snapshot`);
      });
    }
  };

  // A pass never throws: a failed read of the hosts or settings is one log line, the next event tries again.
  const push = (targetHostIds?: readonly string[]): Promise<void> => {
    if (ctx.isDisposed?.()) return Promise.resolve();
    if (inflight) {
      dirty = true;
      return inflight;
    }
    const run = (async () => {
      try {
        await writeHosts(targetHostIds);
      } catch (cause) {
        if (!ctx.isDisposed?.()) ctx.bb.log?.warn?.(`Lane Pilot usage snapshot pass failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        inflight = null;
      }
      if (dirty && !ctx.isDisposed?.()) {
        dirty = false;
        await push();
      }
    })();
    inflight = run;
    return run;
  };

  return { push, forgetHost: (hostId: string) => { last.delete(hostId); } };
}

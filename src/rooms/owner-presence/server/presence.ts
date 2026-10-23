import { runOnHost } from "@lane-pilot/host-calls";
import { mapListedQaHosts } from "../../qa";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { PRESENCE_FILE, presenceHold, readPresence, type Presence } from "../logic";

/**
 * Every two minutes the presence marks of every connected machine are read (one `cat`, a missing file is no presence) and kept in memory;
 * the writer's spawn asks `holds(provider)` next to the breaker. A machine that does not answer keeps its last known marks.
 */
export function createOwnerPresence(ctx: Pick<ServerCore, "bb" | "host" | "log">) {
  const byHost = new Map<string, string>();
  let presence: Presence[] = [];

  async function sweep(): Promise<Presence[]> {
    const hosts = mapListedQaHosts(await (ctx.bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => [])).filter((host) => host.connected);
    for (const host of hosts) {
      const ran = await runOnHost(ctx.host, { hostId: host.id, cwd: "/", command: `cat ${PRESENCE_FILE} 2>/dev/null || echo '{}'`, timeoutSec: 15 }).catch(() => null);
      if (ran && ran.exitCode === 0) byHost.set(host.id, ran.stdout.trim());
    }
    presence = readPresence([...byHost].map(([hostId, text]) => ({ hostId, text })));
    return presence;
  }

  return { ownerPresence: { sweep, holds: (providerId: string, now = Date.now()) => presenceHold(providerId, presence, now), current: () => presence } };
}
export type OwnerPresenceApi = ReturnType<typeof createOwnerPresence>["ownerPresence"];

export function mountOwnerPresence(ctx: ServerCore, api: OwnerPresenceApi): void {
  void api.sweep().catch(() => undefined);
  scheduleIsolated(ctx.bb, "owner-presence", "*/2 * * * *", async () => {
    if (ctx.isDisposed()) return;
    await api.sweep().catch((cause: unknown) => ctx.log(`owner presence sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 90_000 });
}

import { resolve } from "node:path";

/** `workspace.provider`: «auto» (the default) gives writer attempts Lane Pilot's own environment provider; «off» is the emergency switch. */
export function providerSwitchOn(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return !(value === "off" || value === false || value === "false" || value === 0 || value === "0");
}

export const PROVIDER_FAILURES_BEFORE_DISABLE = 3;
/** A machine whose provider was switched off is tried again after this long (one attempt: a failure switches it off again). */
export const PROVIDER_PROBE_AFTER_MS = 3600_000;
const HOST_PREFIX = "workspace-provider:host:";
const hostKey = (hostId: string) => `${HOST_PREFIX}${hostId}`;
type HostRecord = { version: string; failures: number; disabled: boolean; disabledAt?: number; lastReason?: string };
export type ProviderHostStatus = { hostId: string; failures: number; disabled: boolean; disabledAt: number | null; probeAt: number | null; lastReason: string | null };

/**
 * The provider's health per machine. Three failures in a row on one machine (each already served by the old worktree
 * path) switch the provider off there; the warning names the machine so the self-repair watcher picks it up as an incident.
 * It is tried again after an hour (the next attempt goes through the provider; one more failure switches it off for another
 * hour, a success clears the count), and `reset` / the `workspace_provider_reset` RPC lifts it at once. A state of another
 * version is a fixed build's: it starts clean.
 */
export function createProviderGate(input: {
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown>; delete?(key: string): Promise<unknown>; list?(prefix?: string): Promise<string[]> };
  serialized: <T>(work: () => Promise<T>) => Promise<T>;
  version: string;
  warn: (message: string) => void;
  now?: () => number;
  probeAfterMs?: number;
}) {
  const now = input.now ?? Date.now, probeAfterMs = input.probeAfterMs ?? PROVIDER_PROBE_AFTER_MS;
  const read = async (hostId: string): Promise<HostRecord> => {
    const row = await input.kv.get<HostRecord>(hostKey(hostId)).catch(() => null);
    return row && row.version === input.version ? row : { version: input.version, failures: 0, disabled: false };
  };
  const write = (hostId: string, row: HostRecord) => input.kv.set(hostKey(hostId), row as never).then(() => undefined, () => undefined);
  // A record without a time (written before the hour existed) is tried at once.
  const due = (row: HostRecord) => row.disabled && now() - (row.disabledAt ?? 0) >= probeAfterMs;
  const status = (hostId: string, row: HostRecord): ProviderHostStatus => ({
    hostId, failures: row.failures, disabled: row.disabled, disabledAt: row.disabledAt ?? null,
    probeAt: row.disabled ? (row.disabledAt ?? 0) + probeAfterMs : null, lastReason: row.lastReason ?? null,
  });
  return {
    /** False while the provider is switched off on this machine; true again an hour after it was (the probe). */
    usable: async (hostId: string) => {
      const row = await read(hostId);
      if (!row.disabled) return true;
      if (!due(row)) return false;
      return await input.serialized(async () => {
        const current = await read(hostId);
        if (!current.disabled) return true;
        if (!due(current)) return false;
        // Half open: one more failure switches it off again at once.
        await write(hostId, { version: input.version, failures: PROVIDER_FAILURES_BEFORE_DISABLE - 1, disabled: false, lastReason: current.lastReason ?? "probe" });
        return true;
      });
    },
    succeeded: (hostId: string) => input.serialized(async () => {
      const row = await read(hostId);
      if (row.failures) await write(hostId, { version: input.version, failures: 0, disabled: false });
    }),
    /** Counts a failure; true when this one switched the provider off on the machine. */
    failed: (hostId: string, reason: string) => input.serialized(async () => {
      const row = await read(hostId);
      const failures = row.failures + 1;
      const disabled = row.disabled || failures >= PROVIDER_FAILURES_BEFORE_DISABLE;
      await write(hostId, { version: input.version, failures, disabled, ...(disabled ? { disabledAt: row.disabled ? row.disabledAt ?? now() : now() } : {}), lastReason: reason.slice(0, 300) });
      if (disabled && !row.disabled) {
        input.warn(`Lane Pilot workspace provider failed ${failures} times in a row on host ${hostId} (last: ${reason}); it is switched off there for ${Math.round(probeAfterMs / 60_000)} min (or until workspace_provider_reset), writer worktrees use the old path`);
      }
      return disabled && !row.disabled;
    }),
    /** Lifts the switch-off now, on one machine or (no id) on every machine this plugin has a record for. Returns the machines cleared. */
    reset: (hostId?: string) => input.serialized(async () => {
      const hosts = hostId ? [hostId] : (await (input.kv.list?.(HOST_PREFIX) ?? Promise.resolve([] as string[])).catch(() => [] as string[])).map((key) => key.slice(HOST_PREFIX.length));
      const cleared: string[] = [];
      for (const host of hosts) {
        const row = await read(host);
        if (!row.disabled && !row.failures) continue;
        await write(host, { version: input.version, failures: 0, disabled: false });
        cleared.push(host);
      }
      return cleared;
    }),
    /** What the gate knows per machine, for the status RPC. */
    hosts: async (): Promise<ProviderHostStatus[]> => {
      const keys = await (input.kv.list?.(HOST_PREFIX) ?? Promise.resolve([] as string[])).catch(() => [] as string[]);
      return await Promise.all(keys.map(async (key) => { const hostId = key.slice(HOST_PREFIX.length); return status(hostId, await read(hostId)); }));
    },
  };
}
export type ProviderGate = ReturnType<typeof createProviderGate>;

/** The provider is registered in this core and offers itself on this machine. A core without the API lists none. */
export async function providerListed(
  listProviders: (args: { projectId: string; hostId: string }) => Promise<unknown>,
  providerId: string, projectId: string, hostId: string,
): Promise<boolean> {
  const rows = await Promise.resolve().then(() => listProviders({ projectId, hostId })).catch(() => null);
  if (!Array.isArray(rows)) return false;
  const found = rows.find((row) => row && typeof row === "object" && (row as { id?: unknown }).id === providerId) as { availability?: { status?: string } | null } | undefined;
  return Boolean(found) && found?.availability?.status !== "unavailable";
}

/**
 * Waits until the thread's environment is ready on the worktree that was asked for. «error» and «destroyed» (the
 * provider's create refused or failed), a thread that failed before it had an environment, and the deadline are
 * provider failures: the caller falls back.
 */
export async function waitProviderEnvironment(input: {
  threadId: string; spawnEnvironmentId?: string | null; expectedPath: string;
  getThread: (threadId: string) => Promise<unknown>;
  getEnvironment: (environmentId: string) => Promise<unknown>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number;
}): Promise<{ ok: true; environmentId: string } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = now() + (input.timeoutMs ?? 120_000);
  const text = (value: unknown, key: string) => {
    const found = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
    return typeof found === "string" && found ? found : null;
  };
  let environmentId = input.spawnEnvironmentId?.trim() || "";
  let last = environmentId ? "bound" : "unbound";
  while (now() < deadline) {
    const thread = await input.getThread(input.threadId).catch(() => null);
    environmentId = text(thread, "environmentId") ?? environmentId;
    if (environmentId) {
      const environment = await input.getEnvironment(environmentId).catch(() => null);
      const status = text(environment, "status") ?? "unknown";
      last = status;
      if (status === "error" || status === "destroyed") return { ok: false, reason: `environment_${status}:${text(environment, "statusMessage") ?? ""}` };
      if (status === "ready") {
        const path = text(environment, "path");
        if (path && resolve(path) !== resolve(input.expectedPath)) return { ok: false, reason: `environment_path_mismatch:${path}` };
        return { ok: true, environmentId };
      }
    } else if (text(thread, "status") === "error") return { ok: false, reason: "thread_error_before_environment" };
    await sleep(input.intervalMs ?? 500);
  }
  return { ok: false, reason: `environment_timeout:${last}` };
}

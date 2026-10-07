import { resolve } from "node:path";

/** `workspace.provider`: «auto» (the default) gives writer attempts Lane Pilot's own environment provider; «off» is the emergency switch. */
export function providerSwitchOn(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return !(value === "off" || value === false || value === "false" || value === 0 || value === "0");
}

export const PROVIDER_FAILURES_BEFORE_DISABLE = 3;
const hostKey = (hostId: string) => `workspace-provider:host:${hostId}`;
type HostRecord = { version: string; failures: number; disabled: boolean };

/**
 * The provider's health per machine. Three failures in a row on one machine (each already served by the old worktree
 * path) switch the provider off there until the plugin version changes; the warning names the machine so the
 * self-repair watcher picks it up as an incident. A state of another version is a fixed build's: it starts clean.
 */
export function createProviderGate(input: {
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
  serialized: <T>(work: () => Promise<T>) => Promise<T>;
  version: string;
  warn: (message: string) => void;
}) {
  const read = async (hostId: string): Promise<HostRecord> => {
    const row = await input.kv.get<HostRecord>(hostKey(hostId)).catch(() => null);
    return row && row.version === input.version ? row : { version: input.version, failures: 0, disabled: false };
  };
  const write = (hostId: string, row: HostRecord) => input.kv.set(hostKey(hostId), row as never).then(() => undefined, () => undefined);
  return {
    /** False once the provider failed three times in a row on this machine under this version. */
    usable: (hostId: string) => read(hostId).then((row) => !row.disabled),
    succeeded: (hostId: string) => input.serialized(async () => {
      const row = await read(hostId);
      if (row.failures) await write(hostId, { ...row, failures: 0 });
    }),
    /** Counts a failure; true when this one switched the provider off on the machine. */
    failed: (hostId: string, reason: string) => input.serialized(async () => {
      const row = await read(hostId);
      const failures = row.failures + 1;
      const disabled = row.disabled || failures >= PROVIDER_FAILURES_BEFORE_DISABLE;
      await write(hostId, { version: input.version, failures, disabled });
      if (disabled && !row.disabled) {
        input.warn(`Lane Pilot workspace provider failed ${failures} times in a row on host ${hostId} (last: ${reason}); it is switched off there until the plugin version changes, writer worktrees use the old path`);
      }
      return disabled && !row.disabled;
    }),
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

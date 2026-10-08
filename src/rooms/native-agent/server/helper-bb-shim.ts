import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { stringAt } from "../../core/server";
import type { ServerCore } from "../../core/server";

/**
 * Codex, OpenCode and Cursor threads Lane Pilot starts get the guard wrappers (src/bb-shim.ts) at the front of their PATH, so a
 * writer or helper on them meets the same refusals as on Claude Code (audit 2026-10-08 round 3, P0-2). The machine of the thread
 * writes the wrappers and says the PATH (host call `prepareBbShim`); the thread's own PATH is not readable from here, so the
 * host worker's is used, which is the one BB's daemon hands its threads.
 *
 * Only threads Lane Pilot started carry a `role`; the owner's own chats keep their PATH. The PM (role `pm`) is on Claude Code and
 * reloads its own plugin, so it is left out. A host that does not know the call yet (older install) is not a reason to stop a
 * helper: it starts without the wrappers and the log says so; any other failure refuses the start, like the OpenCode config does.
 */
export const BB_SHIM_PROVIDER_IDS = ["codex", "acp-cursor"] as const;
const CACHE_MS = 60_000;
const CALL_MS = 4_000;
const UNKNOWN_CALL = /unknown|not found|no such|not implemented|unsupported|not a function|unrecognized/i;

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 200);

/** Runs `work` but gives up on it after `ms`. */
async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

type Shim = { dir: string; path: string } | null;

export function createBbShimEnv(ctx: Pick<ServerCore, "bb" | "host">, now: () => number = Date.now) {
  const { bb, host } = ctx;
  const cache = new Map<string, { at: number; value: Shim }>();
  const inflight = new Map<string, Promise<Shim>>();

  async function prepare(hostId: string): Promise<Shim> {
    const hit = cache.get(hostId);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const running = inflight.get(hostId);
    if (running) return await running;
    const work = (async (): Promise<Shim> => {
      try {
        const answer = await within(CALL_MS, "prepareBbShim", Promise.resolve(host.call("prepareBbShim", { requestedHostId: hostId }, { hostId, timeoutMs: CALL_MS })));
        const value = answer as unknown as { dir: string; path: string };
        cache.set(hostId, { at: now(), value });
        return value;
      } catch (cause) {
        if (UNKNOWN_CALL.test(reasonOf(cause))) {
          bb.log.warn(`Lane Pilot: host ${hostId} does not know prepareBbShim (${reasonOf(cause)}); its helpers start without the bb guard wrappers until the host is updated`);
          return null;
        }
        throw new Error(`bb_shim_failed:${hostId}: ${reasonOf(cause)}`);
      }
    })().finally(() => { inflight.delete(hostId); });
    inflight.set(hostId, work);
    return await work;
  }

  return async (context: { threadId: string; hostId: string }): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    let metadata: unknown = null;
    try { metadata = await within(CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); } catch (cause) {
      bb.log.warn(`Lane Pilot: could not tell whether thread ${context.threadId} is a helper (${reasonOf(cause)}); it starts without the bb guard wrappers`);
      return [];
    }
    const role = stringAt(metadata, "role");
    if (!role || role === "pm") return [];
    const shim = await prepare(context.hostId);
    if (!shim) return [];
    return [{ name: "PATH", value: shim.path, reason: `Lane Pilot: ${role} thread runs bb, ssh, scp and sftp through the guard wrappers in ${shim.dir}`.slice(0, 500) }];
  };
}

export function mountBbShim(ctx: ServerCore) {
  const resolve = createBbShimEnv(ctx);
  for (const providerId of BB_SHIM_PROVIDER_IDS) ctx.bb.providers.experimental_contributeEnv(providerId, resolve);
}

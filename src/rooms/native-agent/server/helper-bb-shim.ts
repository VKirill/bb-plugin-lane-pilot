import { loadProjectSettings } from "../../storage";
import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { stringAt } from "../../core/server";
import type { ServerCore } from "../../core/server";

/**
 * Codex, OpenCode and Cursor threads Lane Pilot starts get the guard wrappers (src/bb-shim.ts) at the front of their PATH, so a
 * writer or helper on them meets the same refusals as on Claude Code (audit 2026-10-08 round 3, P0-2). The machine of the thread
 * writes the wrappers and says the PATH (host call `prepareBbShim`); the thread's own PATH is not readable from here, so the
 * host worker's is used, which is the one BB's daemon hands its threads. OpenCode v2 runs every session in one shared service:
 * its provider sets these variables as the session's shell environment, so they reach the writer's shells, not the service.
 *
 * Only threads Lane Pilot started carry a `role`; the owner's own chats keep their PATH. The same threads get `LANE_PILOT_ROLE`, the
 * marker lane plugins installed for the whole machine check (opencode-lane's guard refused skills in the owner's own OpenCode chats
 * before it did, 2026-10-13). The PM (role `pm`) is on Claude Code and
 * reloads its own plugin, so it is left out. A host that does not know the call yet (older install) is not a reason to stop a
 * helper: it starts without the wrappers and the log says so; any other failure refuses the start.
 */
export const BB_SHIM_PROVIDER_IDS = ["codex", "opencode2", "acp-cursor", "devin"] as const;
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

/**
 * What BB hands an env resolver. The SDK types threadId as a string, but BB's model catalog (core resolveCatalogLaunch) runs every
 * provider's resolver with threadId null to fingerprint the catalog launch: no thread starts there, so a resolver contributes nothing
 * (night repair 2026-10-27, class log:ebdc80fdb6ec: 194 "thread null ... HTTP 404" warnings a day).
 */
export type ProviderEnvContext = { threadId: string | null; hostId: string; experimental_vkPluginMetadata?: unknown };

export function createBbShimEnv(ctx: Pick<ServerCore, "bb" | "host"> & { db?: ServerCore["db"] }, now: () => number = Date.now) {
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

  return async (context: ProviderEnvContext, providerId?: string): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    if (!context.threadId) return [];
    let metadata: unknown = null;
    try { metadata = context.experimental_vkPluginMetadata !== undefined ? context.experimental_vkPluginMetadata : await within(CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); } catch (cause) {
      bb.log.warn(`Lane Pilot: could not tell whether thread ${context.threadId} is a helper (${reasonOf(cause)}); it starts without the bb guard wrappers`);
      return [];
    }
    const role = stringAt(metadata, "role");
    if (!role || role === "pm") return [];
    // The marker the machine's lane plugins and hooks (opencode-lane guard) check: without it they leave the owner's own sessions alone.
    const mark = { name: "LANE_PILOT_ROLE", value: role, reason: `Lane Pilot: ${role} thread; lane plugins and hooks on the machine act only where this is set`.slice(0, 500) };
    const shim = await prepare(context.hostId);
    const home = providerId === "codex" && role === "writer" ? await workerHome(metadata, context.hostId) : null;
    const extra = home ? [{ name: "CODEX_HOME", value: home, reason: "Lane Pilot strict worker: a fresh codex home for this task (worker.strict_user on)" }] : [];
    if (!shim) return [mark, ...extra];
    return [mark, { name: "PATH", value: shim.path, reason: `Lane Pilot: ${role} thread runs bb, ssh, scp and sftp through the guard wrappers in ${shim.dir}`.slice(0, 500) }, ...extra];
  };

  /** The task's own codex home when the run's project has worker.strict_user on; null otherwise or when the host cannot make it. */
  async function workerHome(metadata: unknown, hostId: string): Promise<string | null> {
    const runId = stringAt(metadata, "lanePilotRunId");
    const taskId = stringAt(metadata, "taskId") ?? stringAt(metadata, "attemptId");
    if (!runId || !taskId || !ctx.db) return null;
    const projectId = (ctx.db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(runId) as { project_id?: string } | undefined)?.project_id;
    if (!projectId || String(loadProjectSettings(ctx.db as never, projectId)["worker.strict_user"] ?? "off") !== "on") return null;
    const key = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const made = await within(CALL_MS, "prepareWorkerHome", Promise.resolve(host.call("prepareWorkerHome", { requestedHostId: hostId, key }, { hostId, timeoutMs: CALL_MS }))).catch(() => null);
    return made?.codexHome ?? null;
  }
}

/**
 * Claude Code threads Lane Pilot starts (helpers, critics) get the lane marker alone, no PATH shim: without it the machine's hooks took them
 * for the owner's own sessions (the owner-presence mark, 2026-10-23: a helper probe marked the owner present). BB takes one env resolver per
 * provider, so the claude-code one (core/server/native-wiring.ts) adds this marker to the native session's env.
 */
export function createRoleMarkerEnv(ctx: Pick<ServerCore, "bb">) {
  const { bb } = ctx;
  return async (context: ProviderEnvContext): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    if (!context.threadId) return [];
    let metadata: unknown = null;
    try { metadata = context.experimental_vkPluginMetadata !== undefined ? context.experimental_vkPluginMetadata : await within(CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); } catch { return []; }
    const role = stringAt(metadata, "role");
    if (!role || role === "pm") return [];
    return [{ name: "LANE_PILOT_ROLE", value: role, reason: `Lane Pilot: ${role} thread; lane plugins and hooks on the machine act only where this is set`.slice(0, 500) }];
  };
}

export function mountBbShim(ctx: ServerCore) {
  const resolve = createBbShimEnv(ctx);
  for (const providerId of BB_SHIM_PROVIDER_IDS) ctx.bb.providers.experimental_contributeEnv(providerId, (thread) => resolve(thread, providerId));
}

import { GLOBAL_SETTINGS_PROJECT_ID, SETTING_CODEX_LEAN_ROLES, SETTING_WORKER_STRICT_USER } from "@lane-pilot/settings-catalog";
import { getRun, loadProjectSettings, workerHomeKey } from "../../storage";
import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { PROVIDER_CAPABILITIES } from "@lane-pilot/models";
import { codexLeanEnabled, codexLeanProfile } from "../../contracts";
import { stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";

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
    const codex = PROVIDER_CAPABILITIES[providerId ?? ""]?.requiresWorkerHome === true;
    const strict = codex && role === "writer" ? await workerHome(metadata, context.hostId) : null;
    // Per role (setting codex.lean_roles, default: docs and the one-shot judges; env LANE_PILOT_CODEX_LEAN_HOME=off is the escape hatch):
    // the role starts in a shared trimmed home of its profile instead of the owner's own ~/.codex.
    const lean = !strict && codex && codexLeanEnabled(role, leanRolesSetting(metadata), process.env.LANE_PILOT_CODEX_LEAN_HOME) ? await leanHome(role, context.hostId) : null;
    const home = strict ?? lean;
    const extra = [...(home ? [{ name: "CODEX_HOME", value: home, reason: strict ? "Lane Pilot strict worker: a fresh codex home for this task (worker.strict_user on)" : "Lane Pilot: a trimmed codex home for this role (no app, browser, plugin or subagent tools)" }] : []), ...taskDirEnv(metadata)];
    if (!shim) return [mark, ...extra];
    return [mark, { name: "PATH", value: shim.path, reason: `Lane Pilot: ${role} thread runs bb, ssh, scp and sftp through the guard wrappers in ${shim.dir}`.slice(0, 500) }, ...extra];
  };

  /** `codex.lean_roles` for the thread's project (its own row, else the hub's); unset without a database. */
  function leanRolesSetting(metadata: unknown): unknown {
    if (!ctx.db) return undefined;
    try {
      const runId = stringAt(metadata, "lanePilotRunId");
      const projectId = (runId ? getRun(ctx.db, runId)?.project_id : null) ?? GLOBAL_SETTINGS_PROJECT_ID;
      return loadProjectSettings(ctx.db as never, projectId)[SETTING_CODEX_LEAN_ROLES];
    } catch (cause) {
      bb.log.warn(`Lane Pilot: ${SETTING_CODEX_LEAN_ROLES} unreadable (${reasonOf(cause)}); the default role list applies`);
      return undefined;
    }
  }

  /** The task's own codex home when the run's project has worker.strict_user on; null otherwise or when the host cannot make it. */
  async function workerHome(metadata: unknown, hostId: string): Promise<string | null> {
    const runId = stringAt(metadata, "lanePilotRunId");
    // The key is the attempt that started the thread, as it always was ("taskId" is never set in a thread's metadata): a task id repeats
    // across runs, and a home shared by them would not be a fresh one. The janitor's sweep removes a task's homes by its attempt ids.
    const taskId = stringAt(metadata, "taskId") ?? stringAt(metadata, "attemptId");
    if (!runId || !taskId || !ctx.db) return null;
    const projectId = getRun(ctx.db, runId)?.project_id;
    if (!projectId || String(loadProjectSettings(ctx.db as never, projectId)[SETTING_WORKER_STRICT_USER] ?? "off") !== "on") return null;
    const key = workerHomeKey(taskId);
    if (!key) return null;
    const made = await within(CALL_MS, "prepareWorkerHome", Promise.resolve(host.call("prepareWorkerHome", { requestedHostId: hostId, key, profile: "code" }, { hostId, timeoutMs: CALL_MS }))).catch((cause: unknown) => { bb.log.warn(`Lane Pilot: prepareWorkerHome on ${hostId} failed (${reasonOf(cause)}); helpers start without a worker home`); return null; });
    return made?.codexHome ?? null;
  }

  /** The shared trimmed codex home of a role's profile (`lean-<profile>`: the janitor names homes by attempt ids, so it never sweeps these). */
  async function leanHome(role: string, hostId: string): Promise<string | null> {
    const profile = codexLeanProfile(role);
    const made = await within(CALL_MS, "prepareWorkerHome", Promise.resolve(host.call("prepareWorkerHome", { requestedHostId: hostId, key: `lean-${profile}`, profile }, { hostId, timeoutMs: CALL_MS }))).catch((cause: unknown) => { bb.log.warn(`Lane Pilot: lean codex home on ${hostId} failed (${reasonOf(cause)}); the thread starts in the machine's own home`); return null; });
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
    return [{ name: "LANE_PILOT_ROLE", value: role, reason: `Lane Pilot: ${role} thread; lane plugins and hooks on the machine act only where this is set`.slice(0, 500) }, ...claudeTrimEnv(role), ...taskDirEnv(metadata)];
  };
}

/**
 * `LANE_TASK_DIR`: the writer's own task home in its worktree, as the spawn put it in the thread's metadata (`laneTaskDir`). The guard hook reads
 * REFLEXES.md and FILECARDS.md only there (docs/task-folder.md); a value that is not `<abs>/.agents/tasks/<id>` is not passed on.
 */
export function taskDirEnv(metadata: unknown): ExperimentalPluginProviderEnvEntry[] {
  const dir = stringAt(metadata, "laneTaskDir");
  if (!dir || !/^\/(?:[^\0]*\/)?\.agents\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dir) || dir.split("/").includes("..")) return [];
  return [{ name: "LANE_TASK_DIR", value: dir, reason: "Lane Pilot: the writer's own task folder; the guard hook reads its notes only there" }];
}

/**
 * Claude Code switches that take weight off a helper session's start, set as env because BB's core owns the CLI flags (checked on Claude Code 2.1.325:
 * one haiku turn in an empty folder, `claude -p` with the same MCP config, total input tokens 21,876 alone, about -150 with cron off, -330 with the Explore/Plan agents off, -460 with the git text off,
 * 20,933 with those three and auto memory (no effect of its own) together; a switch the binary does not know is ignored, so an older install is not refused). Cron tools and the
 * Explore/Plan subagent tools are not for a helper; the git commit/PR protocol text stays only for the roles that may commit. Auto memory needs no
 * switch: the core's session policy (`required`) already turns it off (vk-session-policy.ts).
 */
export function claudeTrimEnv(role: string): ExperimentalPluginProviderEnvEntry[] {
  const reason = "Lane Pilot: a helper session starts without this Claude Code surface (token trim)";
  const names = ["CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS"];
  if (!["writer", "code-repair", "night-fixer"].includes(role)) names.push("CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS");
  return names.map((name) => ({ name, value: "1", reason }));
}

/**
 * The PM's thread and project ids in the session env: the bundled PostToolUse hook reports a Skill call through
 * `bb lane-pilot pm-skill-use` only when these are set, so writer and helper sessions stay silent. (A3, audit Fable 5.1-8)
 */
export function createPmSkillTraceEnv(ctx: Pick<ServerCore, "bb">) {
  const { bb } = ctx;
  return async (context: ProviderEnvContext): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    if (!context.threadId) return [];
    let metadata: unknown = null;
    try { metadata = context.experimental_vkPluginMetadata !== undefined ? context.experimental_vkPluginMetadata : await within(CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); } catch { return []; }
    if (stringAt(metadata, "role") !== "pm") return [];
    const reason = "Lane Pilot: PM skill-use trace; the session hook reports which skills the PM opens";
    const env: ExperimentalPluginProviderEnvEntry[] = [{ name: "LANE_PILOT_PM_THREAD_ID", value: context.threadId, reason }];
    const thread = await orMiss(bb.sdk.threads.get({ threadId: context.threadId }), null, isNotFound);
    const projectId = stringAt(thread, "projectId");
    if (projectId) env.push({ name: "LANE_PILOT_PM_PROJECT_ID", value: projectId, reason });
    return env;
  };
}

export function mountBbShim(ctx: ServerCore) {
  const resolve = createBbShimEnv(ctx);
  for (const providerId of BB_SHIM_PROVIDER_IDS) ctx.bb.providers.experimental_contributeEnv(providerId, (thread) => resolve(thread, providerId));
}

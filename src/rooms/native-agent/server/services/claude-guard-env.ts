import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isToolTier } from "@lane-pilot/contracts";
import { nativeThreadKey, resolvePlanningHome } from "../../../contracts";
import { getReasoningTrace, getRun, planningHomeInputs, saveReasoningTrace, type LanePilotDatabase } from "../../../storage";
import type { RunCommandHost } from "@lane-pilot/host-calls";
import { stringAt } from "@lane-pilot/kit";
import { WRITER_ROLES, parseTaskDir } from "../../models/claude-guard";

type EnvEntry = { name: string; value: string; reason: string };

const CACHE_MS = 60_000;
const CALL_MS = 8_500;

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 200);

async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

type HostCall = { call(method: string, input: unknown, options: { hostId: string }): Promise<unknown> };

/** The PM's planning home for the bundled guard (SMA d_project_planning): the confirmed home's path, or null. */
async function pmPlanningHome(ctx: { bb: BbPluginApi; db: LanePilotDatabase; nativeHost: HostCall }, thread: { threadId: string | null; hostId: string }, metadata: unknown, cwd: string | null): Promise<string | null> {
  const runId = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).lanePilotRunId : null;
  const run = typeof runId === "string" && runId ? getRun(ctx.db, runId) : null;
  if (!run || !cwd) return null;
  const host = { call: (method: string, input: unknown, options: { hostId: string }) => ctx.nativeHost.call(method, input, options) } as unknown as RunCommandHost;
  return resolvePlanningHome({ host, hostId: thread.hostId, cwd, inputs: planningHomeInputs(ctx.db, run.project_id), log: ctx.bb.log });
}

export function recordAttemptIsolation(
  db: LanePilotDatabase | undefined,
  attemptId: string | null | undefined,
  isolation: { role: string; providerId: string; denies: number; sandbox: boolean; pushEnv: boolean; warning?: string },
): void {
  if (!attemptId || typeof (db as { prepare?: unknown } | undefined)?.prepare !== "function") return;
  try {
    const trace = getReasoningTrace(db as LanePilotDatabase, attemptId);
    if (trace) saveReasoningTrace(db as LanePilotDatabase, { ...trace, isolation });
  } catch { /* best-effort trace annotation; never block thread spawn */ }
}

/**
 * Claude Code threads Lane Pilot started (PM, helpers, writers, errands) get the bundled guard through
 * BB_CLAUDE_CODE_EXECUTABLE. Native sessions already have their own launcher. The owner's chats have no role.
 * (2026-10-29 claude-guard)
 */
export function createClaudeGuardEnv(ctx: { bb: BbPluginApi; db: LanePilotDatabase; nativeHost: HostCall }) {
  const cache = new Map<string, { at: number; env: EnvEntry[]; isolation?: { denies: number; sandbox: boolean } }>();
  return async (thread: { threadId: string | null; hostId: string }): Promise<EnvEntry[]> => {
    if (!thread.threadId) return [];
    const native = await ctx.bb.storage.kv.get(nativeThreadKey(thread.threadId));
    if (native) return [];
    let metadata: unknown = null;
    try {
      metadata = await within(CALL_MS, "getPluginMetadata", Promise.resolve(ctx.bb.sdk.threads.getPluginMetadata({ threadId: thread.threadId })));
    } catch (cause) {
      ctx.bb.log.warn(`Lane Pilot: could not tell whether thread ${thread.threadId} needs the claude guard (${reasonOf(cause)}); it starts without a bundled guard`);
      return [];
    }
    const role = metadata && typeof metadata === "object" && typeof (metadata as Record<string, unknown>).role === "string" ? (metadata as Record<string, unknown>).role as string : undefined;
    if (!role) return [];
    let cwd: string | null = null;
    try {
      const row = await ctx.bb.sdk.threads.get({ threadId: thread.threadId });
      const environmentId = row && typeof row.environmentId === "string" ? row.environmentId.trim() : "";
      if (environmentId) {
        const environment = await ctx.bb.sdk.environments.get({ environmentId });
        const path = environment && typeof environment.path === "string" ? environment.path.trim() : "";
        if (path.startsWith("/")) cwd = path;
      }
    } catch { /* the guard still applies; the project's own hooks are copied only when the workspace is known */ }
    const attemptId = stringAt(metadata, "attemptId") ?? null;
    const rawEffect = stringAt(metadata, "nodeEffect");
    const nodeEffect = isToolTier(rawEffect) ? rawEffect : undefined;
    const taskHome = WRITER_ROLES.has(role) ? parseTaskDir(metadata) : null;
    const key = `${thread.hostId}\n${role}\n${cwd ?? ""}\n${taskHome ?? ""}\n${nodeEffect ?? ""}`;
    const hit = cache.get(key);
    const now = Date.now();
    // The planning home is per project, never cached: two projects can share one checkout path, and a cleared setting must apply at once.
    const withHome = async (base: EnvEntry[], isolation?: { denies: number; sandbox: boolean }): Promise<EnvEntry[]> => {
      if (WRITER_ROLES.has(role)) {
        const denies = isolation?.denies ?? 0;
        const sandbox = isolation?.sandbox === true;
        ctx.bb.log.info?.(`writer.isolation attempt=${attemptId ?? "none"} denies=${denies} sandbox=${sandbox ? "on" : "off"} push_env=on`);
        let warning: string | undefined;
        if (!sandbox) {
          warning = "claude-code host did not return sandbox isolation settings";
          ctx.bb.log.warn?.(`writer.isolation attempt=${attemptId ?? "none"} provider=claude-code does not accept sandbox keys (${warning})`);
        }
        recordAttemptIsolation(ctx.db, attemptId, {
          role,
          providerId: "claude-code",
          denies,
          sandbox,
          pushEnv: true,
          ...(warning ? { warning } : {}),
        });
      }
      const env = [...base];
      // Only a confirmed home travels to the guard (resolvePlanningHome runs the host-side git check);
      // a failure leaves the PM writing in the checkout only, as today.
      if (role === "pm") {
        const home = await pmPlanningHome(ctx, thread, metadata, cwd).catch(() => null);
        if (home) env.push({ name: "LANE_PILOT_PLANNING_HOME", value: home, reason: `Lane Pilot: the PM writes its planning folders under the confirmed planning home` });
      }
      return env;
    };
    if (hit && now - hit.at < CACHE_MS) return withHome(hit.env, hit.isolation);
    try {
      if (nodeEffect) {
        const nodeId = stringAt(metadata, "lanePilotWorkflowNode") ?? role;
        ctx.bb.log.debug?.(`wf.launch node=${nodeId} effect=${nodeEffect}`);
      }
      const prepared = await within(CALL_MS, "prepareClaudeGuard", Promise.resolve(ctx.nativeHost.call("prepareClaudeGuard", {
        role, ...(cwd ? { cwd } : {}), ...(taskHome ? { taskHome } : {}), ...(nodeEffect ? { nodeEffect } : {}),
      }, { hostId: thread.hostId }))) as { env?: EnvEntry[]; isolation?: { denies: number; sandbox: boolean } };
      const env = Array.isArray(prepared?.env) ? prepared.env : [];
      if (!env.some((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")) throw new Error("prepareClaudeGuard returned no launcher");
      cache.set(key, { at: now, env, isolation: prepared.isolation });
      return await withHome(env, prepared.isolation);
    } catch (cause) {
      throw new Error(`claude_guard_failed:${thread.hostId}: ${reasonOf(cause)}`);
    }
  };
}

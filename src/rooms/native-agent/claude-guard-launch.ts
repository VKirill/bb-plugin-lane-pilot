import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sha256Hex } from "@lane-pilot/kit";
import { stringAt } from "../core/server/values";
import { installedClaudeExecutable, shellQuote } from "./native-claude-host";
import { materializeNativeHookSession } from "./native-session-hooks";

type EnvEntry = { name: string; value: string; reason: string };

/**
 * The agent_type the bundled guard's deny list keys on. A PM's metadata role is `pm`; the guard's PM rules
 * key on `lane-pilot-pm`. Every other role is already the guard's name (errand, writer, code-critic, …).
 * (2026-10-29 claude-guard)
 */
export function claudeGuardAgentType(role: string): string {
  return role === "pm" ? "lane-pilot-pm" : role;
}

/** Same launcher shape as a native session: `--settings` with the bundled guard, and no machine-wide hook. No `--agent`. */
export function claudeGuardLauncherScript(input: {
  destDir: string;
  command: string;
  settingsPath: string;
  role: string;
  agentType: string;
}): string {
  const inject = join(input.destDir, "hooks", "inject_agent_type.py");
  const guard = join(input.destDir, "hooks", "guard_shell.py");
  return [
    "#!/bin/sh",
    "unset BB_CLAUDE_CODE_EXECUTABLE",
    'export PATH="$HOME/.agents/bin:$HOME/.local/bin:$PATH"',
    `if [ ! -f ${shellQuote(input.settingsPath)} ] || [ ! -f ${shellQuote(inject)} ] || [ ! -f ${shellQuote(guard)} ]; then`,
    "  echo 'Lane Pilot: claude guard hooks missing' >&2",
    "  exit 78",
    "fi",
    `if [ ! -x ${shellQuote(input.command)} ]; then`,
    "  echo 'Lane Pilot: claude CLI is not executable' >&2",
    "  exit 78",
    "fi",
    `export LANE_PILOT_ROLE=${shellQuote(input.role)}`,
    `export LANE_PILOT_AGENT_TYPE=${shellQuote(input.agentType)}`,
    "export AGENT_HOOK_CLIENT=claude",
    `export LANE_PILOT_HOOK_TRACE=${shellQuote(join(input.destDir, "hook-trace.jsonl"))}`,
    `exec ${shellQuote(input.command)} "$@" --settings ${shellQuote(input.settingsPath)}`,
    "",
  ].join("\n");
}

async function atomicWrite(path: string, content: string, mode: number) {
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, content, { mode });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Writes the bundled guard and a claude launcher for one role. Runs on the host where the thread runs. */
export async function prepareClaudeGuard(input: {
  role: string;
  cwd?: string | null;
  dataDir: string;
}): Promise<{ env: EnvEntry[] }> {
  const role = input.role.trim();
  if (!role) throw new Error("claude_guard_failed: missing role");
  const agentType = claudeGuardAgentType(role);
  const command = await installedClaudeExecutable();
  const cwd = input.cwd?.trim() && input.cwd.startsWith("/") ? input.cwd : null;
  const digest = sha256Hex(JSON.stringify({ role, agentType, command, cwd, version: 1 })).slice(0, 24);
  const dir = join(input.dataDir, "claude-guard", digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const session = await materializeNativeHookSession({ cwd, destDir: dir });
  const launcher = join(dir, "claude");
  await atomicWrite(launcher, claudeGuardLauncherScript({
    destDir: dir,
    command,
    settingsPath: session.settingsPath,
    role,
    agentType,
  }), 0o700);
  const reason = `Lane Pilot: ${role} claude thread runs the bundled guard`.slice(0, 500);
  return {
    env: [
      { name: "BB_CLAUDE_CODE_EXECUTABLE", value: launcher, reason },
      { name: "LANE_PILOT_ROLE", value: role, reason },
      { name: "LANE_PILOT_AGENT_TYPE", value: agentType, reason: `Claude agentSetting ${agentType}`.slice(0, 500) },
    ],
  };
}

const CACHE_MS = 60_000;
const CALL_MS = 4_000;

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 200);

async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

type HostCall = { call(method: string, input: unknown, options: { hostId: string }): Promise<unknown> };

/**
 * Claude Code threads Lane Pilot started (PM, helpers, writers, errands) get the bundled guard through
 * BB_CLAUDE_CODE_EXECUTABLE. Native sessions already have their own launcher. The owner's chats have no role.
 * (2026-10-29 claude-guard)
 */
export function createClaudeGuardEnv(ctx: { bb: BbPluginApi; nativeHost: HostCall }) {
  const cache = new Map<string, { at: number; env: EnvEntry[] }>();
  return async (thread: { threadId: string | null; hostId: string }): Promise<EnvEntry[]> => {
    if (!thread.threadId) return [];
    const native = await ctx.bb.storage.kv.get(`native-thread:${thread.threadId}`).catch(() => null);
    if (native) return [];
    let metadata: unknown = null;
    try {
      metadata = await within(CALL_MS, "getPluginMetadata", Promise.resolve(ctx.bb.sdk.threads.getPluginMetadata({ threadId: thread.threadId })));
    } catch (cause) {
      ctx.bb.log.warn(`Lane Pilot: could not tell whether thread ${thread.threadId} needs the claude guard (${reasonOf(cause)}); it starts without a bundled guard`);
      return [];
    }
    const role = stringAt(metadata, "role");
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
    const key = `${thread.hostId}\n${role}\n${cwd ?? ""}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < CACHE_MS) return hit.env;
    try {
      const prepared = await within(CALL_MS, "prepareClaudeGuard", Promise.resolve(ctx.nativeHost.call("prepareClaudeGuard", {
        role, ...(cwd ? { cwd } : {}),
      }, { hostId: thread.hostId }))) as { env?: EnvEntry[] };
      const env = Array.isArray(prepared?.env) ? prepared.env : [];
      if (!env.some((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")) throw new Error("prepareClaudeGuard returned no launcher");
      cache.set(key, { at: now, env });
      return env;
    } catch (cause) {
      throw new Error(`claude_guard_failed:${thread.hostId}: ${reasonOf(cause)}`);
    }
  };
}

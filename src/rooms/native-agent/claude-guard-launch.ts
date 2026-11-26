import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lane-pilot/kit";
import { resolveCredentialPaths } from "../verification";
import {
  HELPER_DISALLOWED_TOOLS,
  WRITER_DISALLOWED_TOOLS,
  WRITER_MAX_TURNS,
  WRITER_ROLES,
  claudeGuardAgentType,
} from "./models/claude-guard";
import { claudeExecLine, installedClaudeExecutable, shellQuote } from "./native-claude-host";
import { materializeNativeHookSession } from "./native-session-hooks";

export type WriterIsolationSettings = {
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    allowUnsandboxedCommands: false;
    filesystem: { allowWrite: string[]; denyRead: string[] };
  };
};

function realPathVariants(path: string): string[] {
  try {
    const resolved = realpathSync(path);
    return resolved !== path ? [path, resolved] : [path];
  } catch {
    return [path];
  }
}

/**
 * Builds Read/Edit deny rules and Claude Code `sandbox` filesystem boundaries for writer roles.
 * Non-writer roles (PM, critics, helpers) never receive these settings.
 */
export function buildWriterIsolationSettings(input: {
  cwd?: string | null;
  taskHome?: string | null;
  home?: string;
  tempDir?: string;
}): WriterIsolationSettings {
  const creds = resolveCredentialPaths(input.home ?? homedir(), { existingOnly: false });
  const rulePath = (abs: string) => `//${abs.replace(/^\/+/, "")}`;
  const deny = [
    ...creds.dirs.flatMap((dir) => [`Read(${rulePath(dir)}/**)`, `Edit(${rulePath(dir)}/**)`]),
    ...creds.files.flatMap((file) => [`Read(${rulePath(file)})`, `Edit(${rulePath(file)})`]),
  ];
  const allowWrite = [...new Set([
    ...(input.cwd ? realPathVariants(input.cwd) : []),
    ...(input.taskHome ? realPathVariants(input.taskHome) : []),
    ...realPathVariants(input.tempDir ?? tmpdir()),
  ])];
  const denyRead = [...new Set([...creds.dirs, ...creds.files])];
  return {
    permissions: { deny },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite, denyRead },
    },
  };
}

/** Same launcher shape as a native session: `--settings` with the bundled guard, and no machine-wide hook. No `--agent`. */
export function claudeGuardLauncherScript(input: {
  destDir: string;
  command: string;
  settingsPath: string;
  role: string;
  agentType: string;
  /** Turns the launch may run (claude --max-turns); 0/undefined leaves the CLI's own default. */
  maxTurns?: number;
}): string {
  const inject = join(input.destDir, "hooks", "inject_agent_type.py");
  const guard = join(input.destDir, "hooks", "guard_shell.py");
  return [
    "#!/bin/sh",
    "unset BB_CLAUDE_CODE_EXECUTABLE",
    ...(WRITER_ROLES.has(input.role) ? ["unset SSH_AUTH_SOCK"] : []),
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
    "export LANE_SUBAGENT_CAP=0",
    `export LANE_PILOT_HOOK_TRACE=${shellQuote(join(input.destDir, "hook-trace.jsonl"))}`,
    claudeExecLine(input.command, input.settingsPath, [
      ...(input.role === "pm" ? [] : [`--disallowedTools ${shellQuote(WRITER_ROLES.has(input.role) ? `${HELPER_DISALLOWED_TOOLS},${WRITER_DISALLOWED_TOOLS}` : HELPER_DISALLOWED_TOOLS)}`]),
      ...(input.maxTurns && input.maxTurns > 0 ? [`--max-turns ${Math.floor(input.maxTurns)}`] : []),
    ]),
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

type EnvEntry = { name: string; value: string; reason: string };

/** Writes the bundled guard and a claude launcher for one role. Runs on the host where the thread runs. */
export async function prepareClaudeGuard(input: {
  role: string;
  cwd?: string | null;
  taskHome?: string | null;
  dataDir: string;
}): Promise<{ env: EnvEntry[]; isolation?: { denies: number; sandbox: boolean } }> {
  const role = input.role.trim();
  if (!role) throw new Error("claude_guard_failed: missing role");
  const agentType = claudeGuardAgentType(role);
  const command = await installedClaudeExecutable();
  const cwd = input.cwd?.trim() && input.cwd.startsWith("/") ? input.cwd : null;
  const isWriter = WRITER_ROLES.has(role);
  const taskHome = isWriter && input.taskHome?.trim().startsWith("/") ? input.taskHome.trim() : null;
  const isolationSettings = isWriter ? buildWriterIsolationSettings({ cwd, taskHome }) : null;
  const maxTurns = role === "writer" ? WRITER_MAX_TURNS : 0;
  const digest = sha256Hex(JSON.stringify({
    role, agentType, command, cwd, taskHome, maxTurns,
    denies: isolationSettings?.permissions.deny.length ?? 0,
    version: 3,
  })).slice(0, 24);
  const dir = join(input.dataDir, "claude-guard", digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const session = await materializeNativeHookSession({ cwd, destDir: dir });
  if (isolationSettings) {
    const base = JSON.parse(await readFile(session.settingsPath, "utf8")) as Record<string, unknown>;
    const basePerms = base.permissions && typeof base.permissions === "object" && !Array.isArray(base.permissions)
      ? base.permissions as Record<string, unknown>
      : {};
    const existingDeny = Array.isArray(basePerms.deny) ? basePerms.deny.filter((x): x is string => typeof x === "string") : [];
    const mergedDeny = [...existingDeny, ...isolationSettings.permissions.deny.filter((rule) => !existingDeny.includes(rule))];
    const updated = {
      ...base,
      permissions: { ...basePerms, deny: mergedDeny },
      sandbox: isolationSettings.sandbox,
    };
    await atomicWrite(session.settingsPath, `${JSON.stringify(updated, null, 2)}\n`, 0o600);
  }
  const launcher = join(dir, "claude");
  await atomicWrite(launcher, claudeGuardLauncherScript({
    destDir: dir,
    command,
    settingsPath: session.settingsPath,
    role,
    agentType,
    maxTurns,
  }), 0o700);
  const reason = `Lane Pilot: ${role} claude thread runs the bundled guard`.slice(0, 500);
  return {
    env: [
      { name: "BB_CLAUDE_CODE_EXECUTABLE", value: launcher, reason },
      { name: "LANE_PILOT_ROLE", value: role, reason },
      { name: "LANE_PILOT_AGENT_TYPE", value: agentType, reason: `Claude agentSetting ${agentType}`.slice(0, 500) },
    ],
    isolation: {
      denies: isolationSettings?.permissions.deny.length ?? 0,
      sandbox: Boolean(isolationSettings),
    },
  };
}

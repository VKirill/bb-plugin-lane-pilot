import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { stockAgentsOverlayFromInstalled, unionLpBridgeToolsOnAgentsJson } from "./native-agent-overlay";
import { nativeAgentCliId, nativeAgentSettingId } from "./native-session";
import { materializeNativeHookSession } from "./native-session-hooks";

const exec = promisify(execFile);

export function shellQuote(s: string) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function installedClaudeExecutable(): Promise<string> {
  const name = "claude";
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((p) => join(p, name)),
    join(homedir(), ".local/bin", name),
  ];
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      if ((await stat(p)).isFile()) return p;
    } catch { /* next */ }
  }
  throw new Error("claude CLI is not installed on this machine or is missing from PATH.");
}

async function run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return (await exec(command, args, {
    cwd,
    signal,
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  })).stdout;
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error(`Cannot read configuration: ${path}`);
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error instanceof Error ? error : new Error(`Cannot read configuration: ${path}`);
  }
}

async function listMarkdownNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    names.push(basename(entry.name, ".md"));
  }
  return names;
}

async function enabledPluginAgents(
  cwd: string,
  configDir: string,
): Promise<Array<{ id: string; source: string; path: string }>> {
  const enabled: Record<string, boolean> = {};
  for (const path of [
    join(configDir, "settings.json"),
    join(cwd, ".claude/settings.json"),
    join(cwd, ".claude/settings.local.json"),
  ]) {
    const data = await readJsonObject(path);
    const plugins = data.enabledPlugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) continue;
    for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (typeof value === "boolean") enabled[key] = value;
    }
  }
  const registry = await readJsonObject(join(configDir, "plugins/installed_plugins.json"));
  const listed = registry.plugins;
  if (!listed || typeof listed !== "object" || Array.isArray(listed)) return [];
  const agents: Array<{ id: string; source: string; path: string }> = [];
  for (const [key, installations] of Object.entries(listed as Record<string, unknown>)) {
    if (enabled[key] === false || !Array.isArray(installations)) continue;
    const rows = installations.filter((row): row is Record<string, unknown> => {
      if (!row || typeof row !== "object") return false;
      const installPath = Reflect.get(row, "installPath");
      const scope = Reflect.get(row, "scope");
      const projectPath = Reflect.get(row, "projectPath");
      if (typeof installPath !== "string") return false;
      if (scope === "user" || scope === "managed") return true;
      return typeof projectPath === "string" && within(projectPath, cwd);
    });
    const row = rows.sort((left, right) => {
      const rank = (scope: unknown) => scope === "local" ? -2 : scope === "project" ? -1 : 0;
      return rank(left.scope) - rank(right.scope);
    })[0];
    if (!row || typeof row.installPath !== "string") continue;
    const manifest = await readJsonObject(join(row.installPath, ".claude-plugin/plugin.json"));
    if (enabled[key] !== true && manifest.defaultEnabled !== true) continue;
    const name = typeof manifest.name === "string" ? manifest.name : key.split("@")[0]!;
    const extra = manifest.agents;
    const roots = [
      "agents",
      ...(typeof extra === "string" ? [extra] : Array.isArray(extra) ? extra.filter((item): item is string => typeof item === "string") : []),
    ];
    for (const root of new Set(roots)) {
      const resolved = resolve(row.installPath, root);
      if (!within(row.installPath, resolved)) continue;
      for (const nameOnDisk of await listMarkdownNames(resolved)) {
        const id = nativeAgentCliId(nameOnDisk);
        agents.push({ id, source: `plugin:${name}`, path: join(resolved, `${nameOnDisk}.md`) });
      }
    }
  }
  return agents;
}

export async function discoverClaudeAgents(cwd: string, signal?: AbortSignal) {
  const cli = await installedClaudeExecutable();
  const version = (await run(cli, ["--version"], cwd, signal)).trim();
  const help = await run(cli, ["--help"], cwd, signal);
  const agentsFlag = help.includes("--agent ");
  const sessionAgents = help.includes("--agents ");
  const pluginDir = help.includes("--plugin-dir");
  if (!agentsFlag) {
    return { agents: [] as Array<{ id: string; source: string }>, version, sessionAgents, pluginDir, supported: false };
  }
  const home = homedir();
  const dir = process.env.CLAUDE_CONFIG_DIR
    ? resolve(home, process.env.CLAUDE_CONFIG_DIR.replace(/^~\//, home + "/"))
    : join(home, ".claude");
  const agents = new Map<string, { id: string; source: string; path: string }>();
  for (const row of await listInstalledAgentFiles(cwd, dir)) agents.set(row.id, row);
  return {
    agents: [...agents.values()].map(({ id, source }) => ({ id, source })).sort((a, b) => a.id.localeCompare(b.id)),
    version,
    sessionAgents,
    pluginDir,
    supported: true,
  };
}

export async function resolveInstalledAgentFile(cwd: string, agentId: string): Promise<{
  id: string;
  source: string;
  path: string;
} | null> {
  const home = homedir();
  const dir = process.env.CLAUDE_CONFIG_DIR
    ? resolve(home, process.env.CLAUDE_CONFIG_DIR.replace(/^~\//, home + "/"))
    : join(home, ".claude");
  const id = nativeAgentCliId(agentId);
  const agents = new Map<string, { id: string; source: string; path: string }>();
  for (const row of await listInstalledAgentFiles(cwd, dir)) agents.set(row.id, row);
  return agents.get(id) ?? null;
}

async function listInstalledAgentFiles(
  cwd: string,
  configDir: string,
): Promise<Array<{ id: string; source: string; path: string }>> {
  const agents: Array<{ id: string; source: string; path: string }> = [];
  agents.push(...await enabledPluginAgents(cwd, configDir));
  for (const [root, source] of [
    [join(configDir, "agents"), "user"],
    [join(cwd, ".claude/agents"), "project"],
  ] as const) {
    for (const name of await listMarkdownNames(root)) {
      const id = nativeAgentCliId(name);
      agents.push({ id, source, path: join(root, `${name}.md`) });
    }
  }
  return agents;
}

export function catalogHasAgent(agents: Array<{ id: string }>, agentId: string): boolean {
  const id = nativeAgentCliId(agentId);
  return agents.some((row) => nativeAgentCliId(row.id) === id);
}

function sessionAgentsObject(agentId: string, agentsJson: string | null): Record<string, unknown> | null {
  if (!agentsJson) return null;
  return unionLpBridgeToolsOnAgentsJson(nativeAgentCliId(agentId), agentsJson);
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

export function nativeLauncherScript(input: {
  destDir: string;
  command: string;
  settingsPath: string;
  agentId: string;
  settingId: string;
  extraArgs: string[];
}): string {
  const inject = join(input.destDir, "hooks", "inject_agent_type.py");
  const guard = join(input.destDir, "hooks", "guard_shell.py");
  const args = [...input.extraArgs, `--settings ${shellQuote(input.settingsPath)}`, `--agent ${shellQuote(input.agentId)}`];
  return [
    "#!/bin/sh",
    "unset BB_CLAUDE_CODE_EXECUTABLE",
    `if [ ! -f ${shellQuote(input.settingsPath)} ] || [ ! -f ${shellQuote(inject)} ] || [ ! -f ${shellQuote(guard)} ]; then`,
    "  echo 'Lane Pilot: native hooks missing' >&2",
    "  exit 78",
    "fi",
    `if [ ! -x ${shellQuote(input.command)} ]; then`,
    "  echo 'Lane Pilot: claude CLI is not executable' >&2",
    "  exit 78",
    "fi",
    `export LANE_PILOT_AGENT_TYPE=${shellQuote(input.settingId)}`,
    "export AGENT_HOOK_CLIENT=claude",
    `export LANE_PILOT_HOOK_TRACE=${shellQuote(join(input.destDir, "hook-trace.jsonl"))}`,
    `exec ${shellQuote(input.command)} "$@" ${args.join(" ")}`,
    "",
  ].join("\n");
}

export async function prepareNativeClaude(input: {
  cwd?: string | null;
  agentId: string;
  agentsJson: string | null;
  dataDir: string;
  signal?: AbortSignal;
}) {
  const agentId = nativeAgentCliId(input.agentId);
  const cwd = input.cwd?.trim() && input.cwd.startsWith("/") ? input.cwd : null;
  let settingId = nativeAgentSettingId(input.agentId);
  let sessionAgentsJson = input.agentsJson
    ? JSON.stringify(sessionAgentsObject(agentId, input.agentsJson))
    : null;
  let sourceStamp = input.agentsJson ? "edited" : "none";
  if (cwd) {
    const catalog = await discoverClaudeAgents(cwd, input.signal);
    if (!catalog.supported) throw new Error("This Claude Code version does not support --agent.");
    if (!catalogHasAgent(catalog.agents, agentId) && !input.agentsJson) {
      throw new Error(`Agent ${agentId} is not installed in ${cwd}.`);
    }
    settingId = nativeAgentSettingId(
      input.agentId,
      catalog.agents.find((row) => nativeAgentCliId(row.id) === agentId)?.source,
    );
    if (sessionAgentsJson && !catalog.sessionAgents) {
      throw new Error("edited_profile_session_override_unavailable");
    }
    if (!input.agentsJson) {
      const installed = await resolveInstalledAgentFile(cwd, agentId);
      if (!installed) throw new Error(`Agent ${agentId} source file is missing in ${cwd}.`);
      const markdown = await readFile(installed.path, "utf8");
      const overlay = stockAgentsOverlayFromInstalled({
        agentId,
        source: installed.source,
        markdown,
      });
      if (overlay) {
        if (!catalog.sessionAgents) throw new Error("stock_tools_overlay_unavailable");
        sessionAgentsJson = JSON.stringify(overlay);
        sourceStamp = createHash("sha256").update(`${installed.source}\n${markdown}`).digest("hex");
      }
    }
  }
  const command = await installedClaudeExecutable();
  const digest = createHash("sha256").update(JSON.stringify({
    agentId, command, agentsJson: sessionAgentsJson, settingId, sourceStamp, version: 5,
  })).digest("hex").slice(0, 24);
  const dir = join(input.dataDir, "native-launchers", digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const session = await materializeNativeHookSession({
    cwd,
    destDir: dir,
    moduleUrl: import.meta.url,
  });
  const extraArgs: string[] = [];
  if (sessionAgentsJson) {
    const file = join(dir, "agents.json");
    await atomicWrite(file, sessionAgentsJson, 0o600);
    extraArgs.unshift(`--agents ${shellQuote(file)}`);
  }
  const launcher = join(dir, "claude");
  await atomicWrite(launcher, nativeLauncherScript({
    destDir: dir,
    command,
    settingsPath: session.settingsPath,
    agentId,
    settingId,
    extraArgs,
  }), 0o700);
  return {
    env: [
      {
        name: "BB_CLAUDE_CODE_EXECUTABLE",
        value: launcher,
        reason: `Lane Pilot native: ${agentId}`,
      },
      {
        name: "LANE_PILOT_AGENT_TYPE",
        value: settingId,
        reason: `Claude agentSetting ${settingId}`,
      },
    ],
    agentId,
    claudePath: command,
    sessionAgents: Boolean(sessionAgentsJson),
  };
}

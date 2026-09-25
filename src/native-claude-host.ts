import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, delimiter, homedir, isAbsolute, join, relative, resolve } from "node:path";
import { nativeAgentCliId } from "./native-session";

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
): Promise<Array<{ id: string; source: string }>> {
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
  const agents: Array<{ id: string; source: string }> = [];
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
        agents.push({ id, source: `plugin:${name}` });
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
  const agents = new Map<string, { id: string; source: string }>();
  for (const row of await enabledPluginAgents(cwd, dir)) agents.set(row.id, row);
  for (const [root, source] of [
    [join(dir, "agents"), "user"],
    [join(cwd, ".claude/agents"), "project"],
  ] as const) {
    for (const name of await listMarkdownNames(root)) {
      const id = nativeAgentCliId(name);
      agents.set(id, { id, source });
    }
  }
  return { agents: [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)), version, sessionAgents, pluginDir, supported: true };
}

export function catalogHasAgent(agents: Array<{ id: string }>, agentId: string): boolean {
  const id = nativeAgentCliId(agentId);
  return agents.some((row) => nativeAgentCliId(row.id) === id);
}

function sessionAgentsObject(agentId: string, agentsJson: string | null): Record<string, unknown> | null {
  if (!agentsJson) return null;
  const parsed = JSON.parse(agentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("native_agents_json_invalid");
  const body = parsed as Record<string, unknown>;
  const id = nativeAgentCliId(agentId);
  if (body[id] && typeof body[id] === "object") return { [id]: body[id] };
  const only = Object.values(body)[0];
  if (only && typeof only === "object") return { [id]: only };
  throw new Error("native_agents_json_missing_profile");
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

export async function prepareNativeClaude(input: {
  cwd: string;
  agentId: string;
  agentsJson: string | null;
  dataDir: string;
  signal?: AbortSignal;
}) {
  const agentId = nativeAgentCliId(input.agentId);
  const catalog = await discoverClaudeAgents(input.cwd, input.signal);
  if (!catalog.supported) throw new Error("This Claude Code version does not support --agent.");
  if (!catalogHasAgent(catalog.agents, agentId) && !input.agentsJson) {
    throw new Error(`Agent ${agentId} is not installed in ${input.cwd}.`);
  }
  if (input.agentsJson && !catalog.sessionAgents) {
    throw new Error("edited_profile_session_override_unavailable");
  }
  const command = await installedClaudeExecutable();
  const digest = createHash("sha256").update(JSON.stringify({
    agentId, command, agentsJson: input.agentsJson, version: 2,
  })).digest("hex").slice(0, 24);
  const dir = join(input.dataDir, "native-launchers", digest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const args = [`--agent ${shellQuote(agentId)}`];
  if (input.agentsJson) {
    const file = join(dir, "agents.json");
    await atomicWrite(file, JSON.stringify(sessionAgentsObject(agentId, input.agentsJson)), 0o600);
    args.unshift(`--agents ${shellQuote(file)}`);
  }
  const launcher = join(dir, "claude");
  await atomicWrite(
    launcher,
    `#!/bin/sh\nunset BB_CLAUDE_CODE_EXECUTABLE\nexec ${shellQuote(command)} "$@" ${args.join(" ")}\n`,
    0o700,
  );
  return {
    env: [{
      name: "BB_CLAUDE_CODE_EXECUTABLE",
      value: launcher,
      reason: `Lane Pilot native: ${agentId}`,
    }],
    agentId,
    claudePath: command,
    sessionAgents: Boolean(input.agentsJson),
  };
}

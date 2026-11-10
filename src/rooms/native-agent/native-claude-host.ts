import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { unionLpBridgeToolsOnAgentsJson } from "./native-agent-overlay";
import { nativeAgentCliId, nativeAgentSettingId } from "../contracts/native-agent-id";
import { materializeNativeHookSession } from "./native-session-hooks";
import { sha256Hex } from "@lane-pilot/kit";

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
  const args = [...input.extraArgs, `--agent ${shellQuote(input.agentId)}`];
  return [
    "#!/bin/sh",
    "unset BB_CLAUDE_CODE_EXECUTABLE",
    'export PATH="$HOME/.agents/bin:$HOME/.local/bin:$PATH"',
    `if [ ! -f ${shellQuote(input.settingsPath)} ] || [ ! -f ${shellQuote(inject)} ] || [ ! -f ${shellQuote(guard)} ]; then`,
    "  echo 'Lane Pilot: native hooks missing' >&2",
    "  exit 78",
    "fi",
    `if [ ! -x ${shellQuote(input.command)} ]; then`,
    "  echo 'Lane Pilot: claude CLI is not executable' >&2",
    "  exit 78",
    "fi",
    "unset LANE_PILOT_ROLE",
    `export LANE_PILOT_AGENT_TYPE=${shellQuote(input.settingId)}`,
    "export AGENT_HOOK_CLIENT=claude",
    `export LANE_PILOT_HOOK_TRACE=${shellQuote(join(input.destDir, "hook-trace.jsonl"))}`,
    claudeExecLine(input.command, input.settingsPath, args),
    "",
  ].join("\n");
}

/**
 * Claude Code keeps only the last `--settings` it is given. BB core passes its own flag layer (native plugins off,
 * CLAUDE.md excludes, denied MCP servers, skill overrides) as `--settings`, and a launcher that appended the guard file
 * as a second `--settings` threw that layer away: the owner's ADHD and ponytail hooks then ran in every helper (2026-11-07).
 * The exec line merges every `--settings` it sees with the guard file (guard last; hook lists concatenate) and hands
 * Claude one. No `--settings` from core: the guard file goes as before. A layer that cannot be read: guard only, said on stderr.
 *
 * A helper or writer (`LANE_PILOT_ROLE` set by its launcher, not `pm`) does not load the `user` setting source: the person's
 * `~/.claude/settings.json` differs per machine (14 hooks on OVH, none on the Macs, 2026-11-10), so the same role ran under different
 * hooks depending on where it landed, and the person's env keys reached every helper. Its layer is the bundle, the project's hooks
 * and core's flags: the same on every machine (docs/guide/hooks.md, rule 6). MCP servers still connect (live probe). A PM chat keeps
 * the person's layer: it is the owner's own conversation.
 *
 * A helper also runs with Claude Code's auto-memory off: core passes `autoMemoryEnabled: true`, and in a main checkout the folder's
 * `MEMORY.md` (the owner's notes to his own chats, 5 KB on selfystudio) loaded into every helper. The guard layer is merged last, so
 * the switch is set here and needs no core release.
 */
const MERGE_SETTINGS_PY = [
  "import json,os,sys,hashlib,tempfile",
  "cmd,guard=sys.argv[1],sys.argv[2]",
  "rest=sys.argv[3:]; i=rest.index(\"--\"); extra,args=rest[:i],rest[i+1:]",
  "vals=[]; kept=[]; j=0",
  "while j<len(args):",
  "  a=args[j]",
  "  if a==\"--settings\" and j+1<len(args): vals.append(args[j+1]); j+=2; continue",
  "  if a.startswith(\"--settings=\"): vals.append(a[11:]); j+=1; continue",
  "  kept.append(a); j+=1",
  "def load(v):",
  "  v=v.strip()",
  "  if v.startswith(\"{\"): return json.loads(v)",
  "  with open(v) as f: return json.load(f)",
  "def merge(a,b):",
  "  for k,v in b.items():",
  "    if k==\"hooks\" and isinstance(v,dict) and isinstance(a.get(k),dict):",
  "      for ev,lst in v.items(): a[k][ev]=list(a[k].get(ev,[]))+list(lst)",
  "    elif isinstance(v,dict) and isinstance(a.get(k),dict): merge(a[k],v)",
  "    else: a[k]=v",
  "helper=os.environ.get(\"LANE_PILOT_ROLE\",\"pm\")!=\"pm\"",
  "final=guard",
  "if vals or helper:",
  "  try:",
  "    m={}",
  "    for v in vals+[guard]: merge(m,load(v))",
  "    if helper: m[\"autoMemoryEnabled\"]=False",
  "    body=json.dumps(m,sort_keys=True)",
  "    d=os.path.join(tempfile.gettempdir(),\"lane-pilot-claude-settings-%d\"%os.getuid()); os.makedirs(d,mode=0o700,exist_ok=True)",
  "    final=os.path.join(d,hashlib.sha256(body.encode()).hexdigest()[:16]+\".json\")",
  "    fd=os.open(final+\".tmp\",os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)",
  "    with os.fdopen(fd,\"w\") as f: f.write(body)",
  "    os.replace(final+\".tmp\",final)",
  "  except Exception as e:",
  "    sys.stderr.write(\"Lane Pilot: core settings layer unreadable, guard only: %s\\n\"%e); final=guard",
  "if helper:",
  "  nouser=lambda v: \",\".join(x for x in v.split(\",\") if x!=\"user\")",
  "  named=False",
  "  for j,a in enumerate(kept):",
  "    if a.startswith(\"--setting-sources=\"): kept[j]=\"--setting-sources=\"+nouser(a[18:]); named=True",
  "    elif a==\"--setting-sources\" and j+1<len(kept): kept[j+1]=nouser(kept[j+1]); named=True",
  "  if not named: kept.append(\"--setting-sources=project,local\")",
  "os.execv(cmd,[cmd]+kept+[\"--settings\",final]+extra)",
].join("\n");

/** The launcher's last line: exec Claude with one merged `--settings` (see MERGE_SETTINGS_PY), extra args after it. */
export function claudeExecLine(command: string, settingsPath: string, extraArgs: readonly string[] = []): string {
  return `exec python3 -c ${shellQuote(MERGE_SETTINGS_PY)} ${shellQuote(command)} ${shellQuote(settingsPath)} ${extraArgs.join(" ")} -- "$@"`;
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
  }
  const command = await installedClaudeExecutable();
  // (2026-10-29 audit A-027) cwd is part of the launcher id: two projects with the same agent must not share settings.
  const digest = sha256Hex(JSON.stringify({
    agentId, command, agentsJson: sessionAgentsJson, settingId, sourceStamp, cwd, version: 8,
  })).slice(0, 24);
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

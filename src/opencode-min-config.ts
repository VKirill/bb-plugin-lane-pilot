import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";

/**
 * A minimal OpenCode config for Lane Pilot's helper threads (instructions audit 2026-10-08, N1).
 *
 * OpenCode loads whatever is in the machine's global config dir into every session: plugins (a plugin can add tools and
 * instructions), agents and commands. On the OVH machine that dir carries extra plugins, among them `plugin/cursor-acp.js`, and a
 * helper that only says «OK» sent 56.9k input tokens against 35.0k with the same config minus those plugins (measured, both with
 * the MCP servers off as BB's session policy does it). BB's session policy cannot narrow that (it sets `mcp` and `permission.skill`
 * only), `OPENCODE_CONFIG_CONTENT` is merged over the global config (it cannot remove a plugin), and the owner keeps the global
 * config as it is. The one switch that replaces the global config is `XDG_CONFIG_HOME`: OpenCode reads `$XDG_CONFIG_HOME/opencode`.
 *
 * So this builds a config home of our own, per host and per set of kept plugins, under the plugin's data dir:
 *  - `opencode/opencode.json`: the machine's own config minus the `agent` and `command` keys and every plugin that is not kept
 *    (providers, models, `mcp`, permissions stay: BB's session policy reads the MCP names from here to switch servers off);
 *  - `opencode/plugins/`: only the kept local plugins (and the folder next to each one that it imports from);
 *  - every other entry of the real `opencode/` dir (node_modules, agents, commands, skills, ...) and of the real config home
 *    (git, gh, ...) as a link, so tools a helper runs see the same configuration as before.
 * The real files are never written.
 */
export type OpencodeMinInput = {
  dataDir: string;
  /** The model the thread runs on as `provider/model`, to keep the auth plugin its provider needs. */
  model?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
};
export type OpencodeMinResult = { configHome: string; kept: string[]; left: string[] };

/** The owner's per-machine switch: `~/.lane-pilot/opencode-min.json`, `{ "enabled": false }` or `{ "keepPlugins": ["name-or-part"] }`. */
export const OPENCODE_MIN_SWITCH = ".lane-pilot/opencode-min.json";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const pluginName = (spec: unknown): string => (typeof spec === "string" ? spec : Array.isArray(spec) && typeof spec[0] === "string" ? spec[0] : "");
const stem = (name: string) => basename(name, extname(name));

/**
 * Which plugins a thread keeps: always Lane Pilot's own, the owner's list, every authentication plugin (a name with `auth` in
 * it: gemini-auth, openai-codex-auth, anthropic-auth, antigravity-auth, oauth ones), and any plugin named for the provider the
 * thread runs on. An auth plugin adds no tools or instructions, and a helper that goes to a provider whose plugin was left out has
 * no way to sign in (audit 2026-10-08 round 2, B7). What is left out are plugins that add tools or text: cursor-acp, memory
 * capture and the like.
 */
export function keepsPlugin(name: string, providerId: string | null, extra: readonly string[]): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("opencode-lane")) return true;
  if (extra.some((part) => part && lower.includes(part.toLowerCase()))) return true;
  if (lower.includes("auth")) return true;
  if (providerId && providerId.length >= 3 && lower.includes(providerId.toLowerCase())) return true;
  return false;
}

/**
 * OpenCode's own permission rules for the `bash` tool (audit 2026-10-08 round 3, P0-2): the commands a Lane Pilot helper may not run,
 * the same list as the shell guard (lane-stack/hooks/guard_shell.py, strict) and the PATH wrappers (src/bb-shim.ts). A pattern is
 * matched against the whole command line; the last matching rule wins, so these go after whatever the owner's config allows.
 */
export const OPENCODE_BASH_DENY: readonly string[] = [
  ...["set", "delete", "export", "import-machine-env"].map((sub) => `*bb env-catalog ${sub}*`),
  "*bb env-catalog*--raw*",
  "*bb plugin rpc call env-catalog*",
  ...["save_", "reset_", "set_", "stack_install", "stack_connect", "stack_rollback", "native_install_start", "decide_rule_proposal", "rule_set_audience", "memory_record_delete", "prepare_native_session"]
    .map((method) => `*bb plugin rpc call *lane-pilot ${method}*`),
  ...["config", "token", "disable", "enable", "reload", "remove", "safe-mode"].map((sub) => `*bb plugin ${sub}*`),
  ...["configure", "budget", "host-run-cli", "host-install", "host-rollback", "host-connect-opencode", "host-import-config"].map((sub) => `*lane-pilot ${sub}*`),
  ...["ovh-main", "ovh-vps", "vechkasov-ovh", "selfystudio-work", "claude-dev-key", "10.8.0.1", "54.37.129.153"].flatMap((host) => [`*ssh *${host}*`, `*scp *${host}*`, `*sftp *${host}*`, `*rsync *${host}*`]),
  "*base64*|*sh*",
  "*base64*|*bash*",
];

/** The machine's `permission` with the deny rules added to its `bash` rules (a plain `bash: "allow"` becomes `{ "*": "allow" }` first; a global string becomes `{ "*": … }`). */
export function withBashDeny(permission: unknown): Json {
  const base: Json = isObject(permission) ? { ...permission } : typeof permission === "string" ? { "*": permission } : {};
  const bash = base.bash;
  const rules: Json = isObject(bash) ? { ...bash } : typeof bash === "string" ? { "*": bash } : {};
  for (const pattern of OPENCODE_BASH_DENY) { delete rules[pattern]; rules[pattern] = "deny"; }
  return { ...base, bash: rules };
}

/** What of the machine's OpenCode dir is not carried over: the config itself, plugin folders (rebuilt), global rules, logs, backups. */
const NOT_CARRIED = /^(opencode\.jsonc?.*|plugins?|AGENTS\.md|.*\.jsonl(\.\d+)?|opencode\.db.*|.*\.bak.*)$/;

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false);
}

async function readConfig(dir: string): Promise<{ path: string; value: Json } | null> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(dir, name);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const errors: unknown[] = [];
    const value = parseJsonc(text, errors as never, { allowTrailingComma: true });
    if (isObject(value)) return { path, value };
  }
  return null;
}

/** Makes `path` a link to `target`, replacing a link that points elsewhere. */
async function link(target: string, path: string): Promise<void> {
  const existing = await readlink(path).catch(() => null);
  if (existing === target) return;
  await rm(path, { recursive: true, force: true });
  // A concurrent run linked it between the remove and here: fine when it points where we want.
  await symlink(target, path).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code === "EEXIST" && (await readlink(path).catch(() => null)) === target) return;
    throw cause;
  });
}

/** Links every entry of `from` into `into` except those `skip` names; links that no longer have a source are removed. */
async function mirror(from: string, into: string, skip: (name: string) => boolean): Promise<void> {
  const names = (await readdir(from).catch(() => [])).filter((name) => !skip(name));
  for (const name of names) await link(join(from, name), join(into, name));
  for (const name of await readdir(into).catch(() => [])) {
    if (names.includes(name) || skip(name)) continue;
    if ((await lstat(join(into, name)).catch(() => null))?.isSymbolicLink()) await rm(join(into, name), { force: true });
  }
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await readFile(path, "utf8").catch(() => null)) === content) return;
  // Unique per call: runs of one process (a fan-out of helpers) must not share a staging file.
  const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(staging, content, { mode: 0o600 });
  await rename(staging, path);
}

/**
 * Builds (or refreshes) the config home for a thread and says where it is. Null when there is nothing to leave out or nothing to
 * build from: no global OpenCode config on this machine, a switch that turns it off, or a config that is already minimal.
 */
export function prepareOpencodeMinimal(input: OpencodeMinInput): Promise<OpencodeMinResult | null> {
  // One run at a time per data dir: the helpers of a fan-out call this together and write the same files and links.
  const previous = queues.get(input.dataDir) ?? Promise.resolve();
  const run = previous.then(() => build(input), () => build(input));
  queues.set(input.dataDir, run.then(() => undefined, () => undefined));
  return run;
}
const queues = new Map<string, Promise<void>>();

async function build(input: OpencodeMinInput): Promise<OpencodeMinResult | null> {
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const owner = await readFile(join(home, OPENCODE_MIN_SWITCH), "utf8").then((text) => parseJsonc(text) as unknown, () => null);
  if (isObject(owner) && owner.enabled === false) return null;
  const extra = isObject(owner) && Array.isArray(owner.keepPlugins) ? owner.keepPlugins.filter((item): item is string => typeof item === "string") : [];

  const realConfigHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const realDir = join(realConfigHome, "opencode");
  const config = await readConfig(realDir);
  if (!config) return null;
  const providerId = input.model && input.model.includes("/") ? input.model.slice(0, input.model.indexOf("/")) : null;

  const listed = Array.isArray(config.value.plugin) ? config.value.plugin : [];
  const keptSpecs = listed.filter((spec) => keepsPlugin(pluginName(spec), providerId, extra));
  const leftSpecs = listed.filter((spec) => !keptSpecs.includes(spec));
  const keptStems = new Set(keptSpecs.map((spec) => stem(pluginName(spec))));

  // Local plugins found in the dir are loaded whether the config lists them or not: keep the kept ones, leave the rest.
  const localKept: Array<{ dir: string; name: string }> = [];
  const localLeft: string[] = [];
  for (const dir of ["plugins", "plugin"]) {
    for (const name of await readdir(join(realDir, dir)).catch(() => [])) {
      if (keepsPlugin(name, providerId, extra) || keptStems.has(stem(name))) localKept.push({ dir, name });
      else localLeft.push(`${dir}/${name}`);
    }
  }
  const hasAgentKeys = isObject(config.value.agent) && Object.keys(config.value.agent).length > 0;
  const hasCommandKeys = isObject(config.value.command) && Object.keys(config.value.command).length > 0;
  if (!leftSpecs.length && !localLeft.length && !hasAgentKeys && !hasCommandKeys) return null;

  const { agent: _agent, command: _command, ...rest } = config.value;
  const minimal: Json = { ...rest, ...(listed.length ? { plugin: keptSpecs } : {}), permission: withBashDeny(rest.permission) };
  const key = createHash("sha256").update(JSON.stringify({ kept: keptSpecs.map(pluginName), local: localKept.map((item) => `${item.dir}/${item.name}`) })).digest("hex").slice(0, 12);
  const configHome = join(input.dataDir, "opencode-min", key);
  const dir = join(configHome, "opencode");
  await mkdir(join(dir, "plugins"), { recursive: true });

  await writeIfChanged(join(dir, "opencode.json"), `${JSON.stringify(minimal, null, 2)}\n`);
  // The rest of the machine's OpenCode dir (node_modules the kept plugins import from, agents, commands, skills) and of its config home.
  await mirror(realDir, dir, (name) => NOT_CARRIED.test(name));
  await mirror(realConfigHome, configHome, (name) => name === "opencode");
  const wantedPlugins = new Set(localKept.filter((item) => item.dir === "plugins").map((item) => item.name));
  for (const item of localKept) {
    if (item.dir === "plugin") continue;
    await link(join(realDir, "plugins", item.name), join(dir, "plugins", item.name));
  }
  for (const name of await readdir(join(dir, "plugins"))) if (!wantedPlugins.has(name)) await rm(join(dir, "plugins", name), { recursive: true, force: true });
  // A kept plugin of the singular `plugin/` dir is linked the same way.
  if (localKept.some((item) => item.dir === "plugin")) {
    await mkdir(join(dir, "plugin"), { recursive: true });
    for (const item of localKept.filter((entry) => entry.dir === "plugin")) await link(join(realDir, "plugin", item.name), join(dir, "plugin", item.name));
  }

  return { configHome, kept: [...keptSpecs.map(pluginName), ...localKept.map((item) => `${item.dir}/${item.name}`)], left: [...leftSpecs.map(pluginName), ...localLeft] };
}

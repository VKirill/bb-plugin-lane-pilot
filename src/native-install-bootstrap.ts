import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readdir, readlink, lstat, rm, writeFile, symlink } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { atomicText, hashBytes, planFile, planJson, transitionOwned, type NativeInstallManifest, type OwnedFile } from "./native-install-owned";

export const NATIVE_STACK_SHA = "53668987140072ed10495814a2b9d4c744e4cf2c";
const execute = promisify(execFile);
const CLIS = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const result = await execute(command, args, { env, signal, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function which(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try { return (await run("/bin/sh", ["-c", `command -v ${name}`], env)).trim() || null; } catch { return null; }
}

export async function codexRpc(command: string, env: NodeJS.ProcessEnv, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", done = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.stdin.end(); child.kill(); error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("Native installation cancelled"));
    const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => { if (!done) finish(new Error(`Codex app-server exited: ${code}`)); });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) { finish(new Error("Codex response exceeds limit")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) { finish(new Error(message.error.message ?? "Codex RPC failed")); return; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method, params }) + "\n");
        } else finish(null, message.result);
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "lane-pilot-installer", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
  });
}

function rewrite(text: string, from: string, to: string): string { return text.split(from).join(to); }

async function collectFiles(root: string, path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true }).catch(() => [])) {
    if (["__pycache__", ".git"].includes(entry.name) || /\.py[co]$/.test(entry.name)) continue;
    const name = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(root, name)); else result.push(name);
  }
  return result;
}

export async function bootstrapNative(input: { root: string; home?: string; source?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<NativeInstallManifest> {
  const { root, signal } = input, home = input.home ?? homedir();
  await mkdir(root, { recursive: true });
  const source = input.source ?? join(root, "source");
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...input.env, HOME: home };
  const env = { ...baseEnv, PATH: `${join(root, "cli/node_modules/.bin")}:${baseEnv.PATH ?? ""}` };
  if (!input.source) {
    if (!await lstat(join(source, ".git")).catch(() => null)) await run("git", ["clone", "--no-checkout", "https://github.com/VKirill/claude-lane-stack", source], env, signal);
    await run("git", ["-C", source, "checkout", "--detach", NATIVE_STACK_SHA], env, signal);
  }
  const sha = (await run("git", ["-C", source, "rev-parse", "HEAD"], env, signal)).trim();
  if (sha !== NATIVE_STACK_SHA) throw new Error("Unexpected native Lane source revision");
  const installedPrograms: Array<{ name: string; executable: string }> = [];
  for (const [name, packageName] of Object.entries(CLIS)) {
    if (!await which(name, env)) {
      await run("npm", ["install", "--prefix", join(root, "cli"), "--no-audit", "--no-fund", packageName], env, signal);
      const executable = await which(name, env);
      if (!executable) throw new Error(`CLI installation failed: ${name}`);
      installedPrograms.push({ name, executable });
    }
  }
  for (const name of ["git", "python3", "rsync", "bash"]) if (!await which(name, env)) throw new Error(`Native installer requires ${name}`);
  await run("python3", ["-c", "import yaml, jsonschema"], env, signal);
  const stage = join(root, "stage");
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  const bootstrapBin = join(root, "bootstrap-bin");
  await mkdir(bootstrapBin, { recursive: true });
  for (const name of ["claude", "codex", "opencode", "node", "npm", "git", "python3", "rsync", "flock", "bash"]) {
    const path = await which(name, env);
    if (path) { await rm(join(bootstrapBin, name), { force: true }); await symlink(path, join(bootstrapBin, name)); }
  }
  const stageEnv = { ...env, PATH: `${bootstrapBin}:/usr/bin:/bin:/usr/sbin:/sbin`, npm_config_prefix: join(stage, "npm-global"), HOME: stage, XDG_CONFIG_HOME: join(stage, ".config"), XDG_DATA_HOME: join(stage, ".local/share"), CODEX_HOME: join(stage, ".codex"), CLAUDE_CONFIG_DIR: join(stage, ".claude"), LANE_INSTALL_LOCAL_MARKETPLACE: "1", LANE_INSTALL_CLAUDE_PLUGIN: "0", LANE_INSTALL_CODEX_PLUGIN: "0" };
  const openCode = await which("opencode", env);
  if (openCode) { await mkdir(join(stage, ".config/opencode"), { recursive: true }); await writeFile(join(stage, ".config/opencode/opencode.json"), "{}\n"); }
  await run("bash", [join(source, "install.sh")], stageEnv, signal);
  await run("claude", ["plugin", "marketplace", "add", source, "--scope", "user"], stageEnv, signal);
  await run("claude", ["plugin", "install", "lane-stack@claude-lane-stack", "-s", "user"], stageEnv, signal);
  await codexRpc("codex", stageEnv, "plugin/install", { marketplacePath: join(source, ".agents/plugins/marketplace.json"), pluginName: "codex-lane" }, signal);
  const hookInventory = await codexRpc("codex", stageEnv, "hooks/list", { cwds: [stage] }, signal) as { data: Array<{ hooks: Array<{ pluginId: string; key: string; currentHash: string }> }> };
  const hooks = hookInventory.data.flatMap((row) => row.hooks).filter((hook) => hook.pluginId === "codex-lane@claude-lane-stack");
  if (!hooks.length) throw new Error("Codex Lane hooks were not installed");
  const trustedHooks = hooks.map((hook) => `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join("");
  const codexConfig = trustedHooks + await readFile(join(stage, ".codex/config.toml"), "utf8");
  const currentCodex = await readFile(join(home, ".codex/config.toml"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  const manifest: NativeInstallManifest = { schemaVersion: 1, home, sourceSha: sha, state: "prepared", files: [], json: [], blocks: [], preserved: [], createdConfigs: [], createdDirs: [] };
  if (!currentCodex.includes("codex-lane@claude-lane-stack")) manifest.blocks.push({ path: ".codex/config.toml", text: rewrite(codexConfig, stage, home) });
  else manifest.preserved.push(".codex/config.toml: existing Codex Lane registration");
  const roots = [".agents/profiles", ".agents/lib", ".agents/bin", ".agents/hooks", ".agents/board", ".agents/docs", ".agents/templates", ".agents/schemas", ".agents/skills", ".agents/pm-skills", ".agents/agents", ".agents/codex", ".agents/seo-system", ".claude/plugins", ".codex/plugins/cache/claude-lane-stack", ...(openCode ? [".config/opencode/plugins", ".config/opencode/commands", ".config/opencode/agents"] : [])];
  const jsonConfigs = [".claude/settings.json", ".claude/plugins/known_marketplaces.json", ".claude/plugins/installed_plugins.json", ...(openCode ? [".config/opencode/opencode.json"] : [])];
  const singleFiles = [".agents/install.json", ".codex/night-review.config.toml", ".codex/lane-writer.config.toml"];
  const files = [...new Set([...(await Promise.all(roots.map((path) => collectFiles(stage, path)))).flat(), ...singleFiles])];
  for (const path of [".bashrc", ".zshrc"]) {
    const current = await readFile(join(home, path), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    if (!current.includes(".agents/bin")) manifest.blocks.push({ path, text: 'export PATH="$HOME/.agents/bin:$HOME/.local/bin:$PATH"' });
  }
  await mkdir(join(root, "payload"), { recursive: true });
  for (const path of files.filter((path) => !jsonConfigs.includes(path))) {
    const sourcePath = join(stage, path), info = await lstat(sourcePath), payload = `payload/${hashBytes(path)}`;
    let file: OwnedFile;
    if (info.isSymbolicLink()) { const link = rewrite(await readlink(sourcePath), stage, home); file = { path, payload, mode: info.mode & 0o777, link, hash: hashBytes(`link:${link}`) }; }
    else {
      let bytes = await readFile(sourcePath);
      if (!bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes)) bytes = Buffer.from(rewrite(bytes.toString("utf8"), stage, home));
      await writeFile(join(root, payload), bytes);
      file = { path, payload, mode: info.mode & 0o777, hash: hashBytes(bytes) };
    }
    if (await planFile(home, file)) manifest.files.push(file); else manifest.preserved.push(path);
  }
  for (const path of jsonConfigs) {
    const text = await readFile(join(stage, path), "utf8");
    const errors: ParseError[] = [], desired = parse(rewrite(text, stage, home), errors, { allowTrailingComma: true });
    if (errors.length || !desired || typeof desired !== "object" || Array.isArray(desired)) throw new Error(`Invalid staged configuration: ${path}`);
    const target = path === ".config/opencode/opencode.json" && await lstat(join(home, ".config/opencode/opencode.jsonc")).catch(() => null) ? ".config/opencode/opencode.jsonc" : path;
    manifest.json.push(...await planJson(home, target, desired));
  }
  for (const program of installedPrograms) {
    const path = `.local/bin/${program.name}`, file: OwnedFile = { path, payload: "", mode: 0o755, link: program.executable, hash: hashBytes(`link:${program.executable}`) };
    if (await planFile(home, file)) manifest.files.push(file);
  }
  for (const path of [...new Set([...manifest.json.map((edit) => edit.path), ...manifest.blocks.map((block) => block.path)])]) {
    if (!await lstat(join(home, path)).catch(() => null)) manifest.createdConfigs.push(path);
  }
  await atomicText(join(root, "manifest.json"), JSON.stringify(manifest));
  await transitionOwned(root, manifest, "enable", signal);
  await rm(stage, { recursive: true, force: true });
  return manifest;
}

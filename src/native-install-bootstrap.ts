import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { lstat, readFile } from "node:fs/promises";

export const NATIVE_STACK_SHA = "61a45b1df2aa47e5da5b394e2c73a16b9b14b587";
export const CLAUDE_LANE_REPO = "https://github.com/VKirill/claude-lane-stack";
/** Where Claude Lane's own install keeps its checkout; installing here makes Lane Pilot's install the user's install. */
export const CLAUDE_LANE_SOURCE = ".local/share/claude-lane-stack-installed";
const execute = promisify(execFile);

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, cwd?: string): Promise<string> {
  try {
    const result = await execute(command, args, { env, signal, cwd, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`${command} ${args[0] ?? ""} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

async function which(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try { return (await run("/bin/sh", ["-c", `command -v ${name}`], env)).trim() || null; } catch { return null; }
}

/** The host daemon may run with a bare PATH; Claude Lane and its CLIs live in the user's bins. */
export function claudeLaneEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bins = [join(home, ".local/bin"), join(home, ".agents/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...base, HOME: home, PATH: [...bins, base.PATH ?? "/usr/bin:/bin"].join(delimiter) };
}

/** Claude Lane counts as installed when its host install and the Claude plugin are both present. */
export async function detectClaudeLane(home: string): Promise<{ sourceSha: string | null; sourceRepo: string | null } | null> {
  const json = async (path: string) => JSON.parse(await readFile(join(home, path), "utf8").catch(() => "null")) as Record<string, unknown> | null;
  const install = await json(".agents/install.json");
  const plugins = (await json(".claude/plugins/installed_plugins.json"))?.plugins as Record<string, unknown> | undefined;
  const plugin = plugins?.["lane-stack@claude-lane-stack"];
  if (!install || !Array.isArray(plugin) || plugin.length === 0) return null;
  return {
    sourceSha: typeof install.source_sha === "string" ? install.source_sha : null,
    sourceRepo: typeof install.source_repo === "string" ? install.source_repo : null,
  };
}

async function ensurePrerequisites(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (!await which("claude", env)) throw new Error("Claude Code CLI is not installed on this machine.");
  if (!await which("flock", env) && process.platform === "darwin" && await which("brew", env)) {
    await run("brew", ["install", "flock"], env, signal);
  }
  const pythons = [...new Set([await which("python3", env), process.platform === "darwin" ? "/usr/bin/python3" : null].filter(Boolean) as string[])];
  for (const python of pythons) {
    if (!await lstat(python).catch(() => null)) continue;
    const ready = await run(python, ["-c", "import yaml, jsonschema"], env, signal).then(() => true, () => false);
    if (ready) continue;
    // Older pip (macOS Command Line Tools) has no --break-system-packages and needs none.
    const pip = ["-m", "pip", "install", "--user", "pyyaml", "jsonschema"];
    await run(python, [...pip, "--break-system-packages"], env, signal).catch(() => run(python, pip, env, signal));
  }
}

/** Installs Claude Lane exactly as its own install.sh does, at the revision Lane Pilot is tested with. */
export async function installClaudeLane(input: { home?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<{ sourceSha: string | null; sourceRepo: string | null }> {
  const home = input.home ?? homedir(), signal = input.signal;
  const env = claudeLaneEnv(home, input.env);
  await ensurePrerequisites(env, signal);
  const source = join(home, CLAUDE_LANE_SOURCE);
  if (!await lstat(join(source, ".git")).catch(() => null)) await run("git", ["clone", "--quiet", CLAUDE_LANE_REPO, source], env, signal);
  else {
    if ((await run("git", ["-C", source, "status", "--porcelain"], env, signal)).trim()) throw new Error(`Claude Lane checkout has local changes: ${source}`);
    await run("git", ["-C", source, "fetch", "--quiet", "origin"], env, signal);
  }
  await run("git", ["-C", source, "checkout", "--quiet", "--detach", NATIVE_STACK_SHA], env, signal);
  await run("bash", [join(source, "install.sh")], env, signal, source);
  const installed = await detectClaudeLane(home);
  if (!installed) throw new Error("Claude Lane install finished without the lane-stack Claude plugin.");
  return installed;
}

/**
 * Moves Lane Pilot's standard Claude Lane checkout forward to the tested revision and reinstalls.
 * A checkout the user develops in (another path, a branch, local changes, or ahead) is left alone.
 */
export async function upgradeClaudeLane(input: { home: string; source: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<boolean> {
  const { home, source, signal } = input;
  if (source !== join(home, CLAUDE_LANE_SOURCE)) return false;
  const env = claudeLaneEnv(home, input.env);
  const git = (...args: string[]) => run("git", ["-C", source, ...args], env, signal);
  if ((await git("rev-parse", "HEAD")).trim() === NATIVE_STACK_SHA) return false;
  if ((await git("status", "--porcelain")).trim() || (await git("symbolic-ref", "-q", "HEAD").catch(() => "")).trim()) return false;
  await git("fetch", "--quiet", "origin");
  if (!await git("merge-base", "--is-ancestor", "HEAD", NATIVE_STACK_SHA).then(() => true, () => false)) return false;
  await ensurePrerequisites(env, signal);
  await git("checkout", "--quiet", "--detach", NATIVE_STACK_SHA);
  await run("bash", [join(source, "install.sh")], env, signal, source);
  return true;
}

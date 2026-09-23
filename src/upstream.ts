import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TARGET_SHA, UPSTREAM_REPO } from "./constants";
import { defaultLocalFallback, managedEngineDir, resolveHome } from "./paths";
import { assessEngineCapabilities, inspectEngineCapabilities } from "./upstream-adapter/capabilities";

export type UpstreamReady = {
  path: string;
  sha: string;
  source: "clone" | "local-copy" | "reuse";
  clean: boolean;
  compatible: true;
  adaptedCapabilities: string[];
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function inspectReusable(path: string): Promise<UpstreamReady | null> {
  if (!await isDirectory(path) || !gitOk(path, ["rev-parse", "--git-dir"])) return null;
  if (!await isDirectory(join(path, "profiles/opencode/opencode-lane"))) return null;
  const assessment = assessEngineCapabilities(await inspectEngineCapabilities(path));
  if (!assessment.compatible) return null;
  const sha = git(path, ["rev-parse", "HEAD"]);
  const dirty = git(path, ["status", "--porcelain"]) !== "";
  return {
    path,
    sha,
    source: "reuse",
    clean: !dirty,
    compatible: true,
    adaptedCapabilities: assessment.adaptedCapabilities,
  };
}

function clone(source: string, destination: string): void {
  execFileSync("git", ["clone", "--no-checkout", source, destination], {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(destination, ["checkout", "--detach", TARGET_SHA]);
  const sha = git(destination, ["rev-parse", "HEAD"]);
  if (sha !== TARGET_SHA) throw new Error(`managed source SHA ${sha} does not match reference ${TARGET_SHA}`);
}

export async function ensureUpstream(input: {
  homeDir?: string;
  localFallbackPath?: string;
  moduleUrl?: string;
  preferredRoot?: string;
  forceFreshManaged?: boolean;
}): Promise<UpstreamReady> {
  const home = resolveHome(input.homeDir);
  const fallback = input.localFallbackPath
    ?? (input.moduleUrl ? defaultLocalFallback(input.moduleUrl) : "");
  const candidates = [input.preferredRoot, fallback].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    const reusable = await inspectReusable(candidate);
    if (reusable) return reusable;
  }

  const preferred = managedEngineDir(TARGET_SHA, home);
  const existing = input.forceFreshManaged ? null : await inspectReusable(preferred);
  if (existing) return existing;

  const parent = dirname(preferred);
  await mkdir(parent, { recursive: true });
  const destination = input.forceFreshManaged || await isDirectory(preferred)
    ? managedEngineDir(`${TARGET_SHA}-managed-${randomUUID().slice(0, 8)}`, home)
    : preferred;
  const staging = await mkdtemp(join(parent, `.lane-engine-${TARGET_SHA.slice(0, 8)}-`));
  let source: UpstreamReady["source"] = "clone";
  try {
    let sourceUrl = UPSTREAM_REPO;
    if (fallback && await isDirectory(fallback) && gitOk(fallback, ["rev-parse", "--git-dir"])) {
      const fallbackSha = git(fallback, ["rev-parse", "HEAD"]);
      if (fallbackSha === TARGET_SHA) {
        sourceUrl = fallback;
        source = "local-copy";
      }
    }
    clone(sourceUrl, staging);
    const assessment = assessEngineCapabilities(await inspectEngineCapabilities(staging));
    if (!assessment.compatible) {
      throw new Error(`reference engine is missing required interfaces: ${assessment.diagnostics.map((item) => item.capability).join(", ")}`);
    }
    const clean = git(staging, ["status", "--porcelain"]) === "";
    try {
      await rename(staging, destination);
    } catch (error) {
      const concurrent = await inspectReusable(destination);
      if (concurrent) {
        await rm(staging, { recursive: true, force: true });
        return concurrent;
      }
      throw new Error(`managed destination is occupied and was preserved: ${destination}; ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      path: destination,
      sha: TARGET_SHA,
      source,
      clean,
      compatible: true,
      adaptedCapabilities: assessment.adaptedCapabilities,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

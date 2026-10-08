import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TARGET_SHA, UPSTREAM_REPO } from "../../constants";
import { defaultLocalFallback, managedEngineDir, resolveHome } from "@lane-pilot/kit";
import { spawnAsync } from "@lane-pilot/kit";
import { assessEngineCapabilities, inspectEngineCapabilities } from "./capabilities";

export type UpstreamReady = {
  path: string;
  sha: string;
  source: "clone" | "local-copy" | "reuse";
  clean: boolean;
  compatible: true;
  adaptedCapabilities: string[];
};

/** Throws like execFileSync did: a failed or timed-out git is an error carrying its stderr. */
async function runGit(cwd: string | undefined, args: string[], timeout: number): Promise<string> {
  const ran = await spawnAsync("git", args, { cwd, timeout });
  if (ran.error || ran.status !== 0) throw new Error(`git ${args[0]} failed: ${(ran.error?.message ?? ran.stderr.trim()) || `exit ${ran.status}`}`);
  return ran.stdout;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args, 30_000)).trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return await runGit(cwd, args, 4000).then(() => true, () => false);
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function inspectReusable(path: string): Promise<UpstreamReady | null> {
  if (!await isDirectory(path) || !await gitOk(path, ["rev-parse", "--git-dir"])) return null;
  if (!await isDirectory(join(path, "profiles/opencode/opencode-lane"))) return null;
  const assessment = assessEngineCapabilities(await inspectEngineCapabilities(path));
  if (!assessment.compatible) return null;
  const sha = await git(path, ["rev-parse", "HEAD"]);
  const dirty = await git(path, ["status", "--porcelain"]) !== "";
  return {
    path,
    sha,
    source: "reuse",
    clean: !dirty,
    compatible: true,
    adaptedCapabilities: assessment.adaptedCapabilities,
  };
}

async function clone(source: string, destination: string): Promise<void> {
  await runGit(undefined, ["clone", "--no-checkout", source, destination], 120_000);
  await git(destination, ["checkout", "--detach", TARGET_SHA]);
  const sha = await git(destination, ["rev-parse", "HEAD"]);
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
    if (fallback && await isDirectory(fallback) && await gitOk(fallback, ["rev-parse", "--git-dir"])) {
      const fallbackSha = await git(fallback, ["rev-parse", "HEAD"]);
      if (fallbackSha === TARGET_SHA) {
        sourceUrl = fallback;
        source = "local-copy";
      }
    }
    await clone(sourceUrl, staging);
    const assessment = assessEngineCapabilities(await inspectEngineCapabilities(staging));
    if (!assessment.compatible) {
      throw new Error(`reference engine is missing required interfaces: ${assessment.diagnostics.map((item) => item.capability).join(", ")}`);
    }
    const clean = await git(staging, ["status", "--porcelain"]) === "";
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

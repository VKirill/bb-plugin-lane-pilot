import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { TARGET_SHA, UPSTREAM_REPO } from "./constants";
import { defaultLocalFallback, resolveHome, upstreamDir } from "./paths";

export type UpstreamReady = {
  path: string;
  sha: string;
  source: "clone" | "local-copy" | "reuse";
  clean: boolean;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function dirtyAllowed(cwd: string): boolean {
  const short = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (short.trim() === "") return true;
  return short.split("\n").every((line) => {
    const path = line.slice(3).trim();
    return path === ".git/hooks/post-commit" || path === ".git/hooks/post-merge"
      || path.endsWith("hooks/post-commit") || path.endsWith("hooks/post-merge");
  });
}

export async function ensureUpstream(input: {
  homeDir?: string;
  localFallbackPath?: string;
  moduleUrl?: string;
}): Promise<UpstreamReady> {
  const home = resolveHome(input.homeDir);
  const dest = upstreamDir(TARGET_SHA, home);
  const fallback = input.localFallbackPath
    ?? (input.moduleUrl ? defaultLocalFallback(input.moduleUrl) : "");

  if (await stat(dest).then(() => true, () => false) && gitOk(dest, ["rev-parse", "HEAD"])) {
    const sha = git(dest, ["rev-parse", "HEAD"]);
    if (sha === TARGET_SHA && dirtyAllowed(dest)) {
      return { path: dest, sha, source: "reuse", clean: git(dest, ["status", "--porcelain"]) === "" };
    }
    await rm(dest, { recursive: true, force: true });
  }

  await mkdir(dest, { recursive: true });
  try {
    execFileSync("git", ["clone", "--no-checkout", UPSTREAM_REPO, dest], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    });
    git(dest, ["checkout", TARGET_SHA]);
    const sha = git(dest, ["rev-parse", "HEAD"]);
    if (sha !== TARGET_SHA) throw new Error(`cloned sha ${sha} != ${TARGET_SHA}`);
    if (!dirtyAllowed(dest)) throw new Error("cloned upstream is dirty");
    return { path: dest, sha, source: "clone", clean: true };
  } catch (cloneError) {
    await rm(dest, { recursive: true, force: true });
    if (!fallback) throw cloneError;
    if (!await stat(fallback).then(() => true, () => false)) {
      throw new Error(`upstream clone failed and fallback missing: ${fallback}`);
    }
    const sourceSha = git(fallback, ["rev-parse", "HEAD"]);
    if (sourceSha !== TARGET_SHA) {
      throw new Error(`fallback sha ${sourceSha} != ${TARGET_SHA}`);
    }
    if (git(fallback, ["status", "--porcelain"]) !== "") {
      throw new Error("fallback upstream is dirty; refusing to copy");
    }
    await mkdir(dest, { recursive: true });
    await cp(fallback, dest, { recursive: true, dereference: false });
    const sha = git(dest, ["rev-parse", "HEAD"]);
    if (sha !== TARGET_SHA) throw new Error(`copied sha ${sha} != ${TARGET_SHA}`);
    if (!dirtyAllowed(dest)) throw new Error("copied upstream is dirty");
    return { path: dest, sha, source: "local-copy", clean: true };
  }
}

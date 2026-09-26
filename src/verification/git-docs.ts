import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withBaseLock } from "./git-integrate";

const run = promisify(execFile);

/** Paths the nightly docs pass never counts as code changes. */
const NOT_CODE = /^(docs\/|\.agents\/|\.bb\/|\.claude\/|dist\/|node_modules\/)/;

export type GitDocsScope = {
  status: "ready" | "not-git" | "failed";
  isRepoRoot: boolean;
  hasDocs: boolean;
  /** Code files committed since the window start or uncommitted now, docs and tooling excluded. */
  changed: string[];
  /** Every path `git status` reports, to tell afterwards what the docs agent touched. */
  dirty: string[];
  /** The machine's own calendar, so docs.hour means the owner's local hour, not the hub's. */
  localDate: string;
  localHour: number;
  reason: string | null;
};

function statusPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow >= 0 ? path.slice(arrow + 4) : path;
}

export async function gitDocsScope(input: { projectCwd: string; sinceEpochMs: number }): Promise<GitDocsScope> {
  const now = new Date();
  const local = {
    localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    localHour: now.getHours(),
  };
  const git = async (...args: string[]) =>
    (await run("git", ["-c", "core.quotePath=false", "-C", input.projectCwd, ...args], { maxBuffer: 8 << 20 })).stdout;
  const hasDocs = await stat(join(input.projectCwd, "docs")).then((info) => info.isDirectory(), () => false);
  let top: string;
  try { top = (await git("rev-parse", "--show-toplevel")).trim(); }
  catch { return { status: "not-git", isRepoRoot: false, hasDocs, changed: [], dirty: [], ...local, reason: null }; }
  try {
    const isRepoRoot = (await realpath(top)) === (await realpath(input.projectCwd));
    const committed = (await git("log", `--since=@${Math.floor(input.sinceEpochMs / 1000)}`, "--name-only", "--pretty=format:")).split("\n");
    const dirty = (await git("status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).map(statusPath);
    const changed = [...new Set([...committed, ...dirty].map((path) => path.trim()).filter((path) => path && !NOT_CODE.test(path)))].sort();
    return { status: "ready", isRepoRoot, hasDocs, changed, dirty, ...local, reason: null };
  } catch (cause) {
    return { status: "failed", isRepoRoot: false, hasDocs, changed: [], dirty: [], ...local, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Line counts of project files cited by docs pages; null for a file that does not exist. */
export async function docsLineCounts(input:{ projectCwd:string; files:string[] }):Promise<Record<string, number | null>> {
  const counts:Record<string, number | null> = {};
  for (const file of input.files.slice(0, 2000)) {
    if (file.startsWith("/") || file.split("/").includes("..")) { counts[file] = null; continue; }
    const text = await readFile(join(input.projectCwd, file), "utf8").catch(() => null);
    counts[file] = text === null ? null : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  return counts;
}

/** Commits only the given docs paths, under the same lock as writer merges, so other work is never swept in. */
export async function commitDocs(input:{ projectCwd:string; paths:string[]; message:string }):Promise<{ status:"committed" | "nothing" | "failed"; commit:string | null; reason:string | null }> {
  const git = (...args:string[]) => run("git", ["-C", input.projectCwd, ...args], { maxBuffer: 8 << 20 });
  try {
    return await withBaseLock(input.projectCwd, async () => {
      if (!input.paths.length) return { status:"nothing" as const, commit:null, reason:null };
      await git("add", "--all", "--", ...input.paths);
      const staged = (await git("diff", "--cached", "--name-only", "--", ...input.paths)).stdout.trim();
      if (!staged) return { status:"nothing" as const, commit:null, reason:null };
      await git("-c", "user.name=Lane Pilot", "-c", "user.email=lane-pilot@localhost", "commit", "-q", "-m", input.message, "--", ...input.paths);
      return { status:"committed" as const, commit:(await git("rev-parse", "HEAD")).stdout.trim(), reason:null };
    });
  } catch (cause) {
    return { status:"failed", commit:null, reason:cause instanceof Error ? cause.message : String(cause) };
  }
}

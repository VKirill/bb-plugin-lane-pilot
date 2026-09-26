import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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

import { execFile } from "node:child_process";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { CODE_FILE, TEST_PATH } from "./docs-jev";
import { withBaseLock } from "./git-integrate";

const run = promisify(execFile);
/** git's empty tree: the base when the repository has no history before the window. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Paths the nightly docs pass never counts as code changes: any docs/ folder, and tooling. */
const NOT_CODE = /(^|\/)docs\/|^(\.agents\/|\.bb\/|\.claude\/|dist\/|node_modules\/)/;

/** A monorepo workspace (package.json or pnpm workspaces) with the product code files it holds. */
export type DocsWorkspace = { path:string; name:string; codeFiles:number };

export type GitDocsScope = {
  status: "ready" | "not-git" | "failed";
  isRepoRoot: boolean;
  hasDocs: boolean;
  /** Code files changed since `base` or uncommitted now, docs and tooling excluded. */
  changed: string[];
  /** The last commit that touched docs/, else the last one before the window: the docs describe this code. */
  base: string | null;
  /** Every path `git status` reports, to tell afterwards what the docs agent touched. */
  dirty: string[];
  /** The repository's workspaces when it is a monorepo; empty otherwise. */
  workspaces: DocsWorkspace[];
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

/** Workspace folders the root package.json or pnpm-workspace.yaml declares; `dir/*` and `dir/**` globs only. */
async function listWorkspaces(projectCwd:string, tracked:string[]):Promise<DocsWorkspace[]> {
  const pkg = await readFile(join(projectCwd, "package.json"), "utf8").then((text) => JSON.parse(text) as { workspaces?:string[] | { packages?:string[] } }, () => null);
  const pnpm = await readFile(join(projectCwd, "pnpm-workspace.yaml"), "utf8").catch(() => "");
  const pnpmBlock = /^packages:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(pnpm)?.[1] ?? "";
  const patterns = [...(Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages ?? []),
    ...[...pnpmBlock.matchAll(/-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((match) => match[1]!)]
    .map((pattern) => pattern.replace(/^\.\//, "").replace(/\/$/, "")).filter((pattern) => pattern && !pattern.startsWith("!"));
  if (!patterns.length) return [];
  const matches = (dir:string) => patterns.some((pattern) => pattern.endsWith("/**") ? dir.startsWith(`${pattern.slice(0, -2)}`)
    : pattern.endsWith("/*") ? posix.dirname(dir) === pattern.slice(0, -2) : dir === pattern);
  const dirs = [...new Set(tracked.filter((path) => posix.basename(path) === "package.json").map((path) => posix.dirname(path)))]
    .filter((dir) => dir !== "." && !dir.split("/").includes("node_modules") && matches(dir)).sort();
  // Each code file belongs to the innermost workspace that holds it.
  const counts = new Map<string, number>();
  for (const path of tracked) {
    if (!CODE_FILE.test(path) || TEST_PATH.test(path) || NOT_CODE.test(path)) continue;
    const owner = dirs.filter((dir) => path.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0];
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return Promise.all(dirs.map(async (dir) => ({ path:dir, codeFiles:counts.get(dir) ?? 0,
    name:await readFile(join(projectCwd, dir, "package.json"), "utf8").then((text) => String((JSON.parse(text) as { name?:string }).name ?? dir), () => dir) })));
}

/**
 * The state of one docs folder: `docsDir` is docs by default, or a monorepo workspace's own docs folder;
 * its base is the last commit that touched that folder.
 */
export async function gitDocsScope(input: { projectCwd: string; sinceEpochMs: number; base?: string; docsDir?: string; exclude?: string[] }): Promise<GitDocsScope> {
  const docsDir = input.docsDir ?? "docs";
  const now = new Date();
  const local = {
    localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    localHour: now.getHours(),
  };
  const git = async (...args: string[]) =>
    (await run("git", ["-c", "core.quotePath=false", "-C", input.projectCwd, ...args], { maxBuffer: 8 << 20 })).stdout;
  // A docs folder, or the single page of a flow.
  const hasDocs = await stat(join(input.projectCwd, docsDir)).then((info) => info.isDirectory() || info.isFile(), () => false);
  let top: string;
  try { top = (await git("rev-parse", "--show-toplevel")).trim(); }
  catch { return { status: "not-git", isRepoRoot: false, hasDocs, changed: [], dirty: [], base: null, workspaces: [], ...local, reason: null }; }
  try {
    const isRepoRoot = (await realpath(top)) === (await realpath(input.projectCwd));
    const base = (input.base ? (await git("rev-parse", "--verify", `${input.base}^{commit}`)).trim() : "")
      // Sub-folders other passes own (docs/flows under the root) do not move this folder's base.
      || (await git("log", "-1", "--format=%H", "--", docsDir, ...(input.exclude ?? []).map((dir) => `:(exclude)${dir}`))).trim()
      || (await git("rev-list", "-1", `--before=@${Math.floor(input.sinceEpochMs / 1000)}`, "HEAD")).trim()
      || EMPTY_TREE;
    const committed = (await git("diff", "--name-only", base, "HEAD")).split("\n");
    const dirty = (await git("status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).map(statusPath);
    const changed = [...new Set([...committed, ...dirty].map((path) => path.trim()).filter((path) => path && !NOT_CODE.test(path)))].sort();
    const workspaces = isRepoRoot ? await listWorkspaces(input.projectCwd, (await git("ls-files")).split("\n").filter(Boolean)) : [];
    return { status: "ready", isRepoRoot, hasDocs, changed, dirty, base, workspaces, ...local, reason: null };
  } catch (cause) {
    return { status: "failed", isRepoRoot: false, hasDocs, changed: [], dirty: [], base: null, workspaces: [], ...local, reason: cause instanceof Error ? cause.message : String(cause) };
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

/**
 * Puts back files the docs agent changed outside the docs it may write: a tracked file returns to HEAD,
 * a file it created is removed. Only paths that were clean before the pass reach here.
 */
export async function revertPaths(input:{ projectCwd:string; paths:string[] }):Promise<{ reverted:string[]; failed:string[] }> {
  const git = (...args:string[]) => run("git", ["-C", input.projectCwd, ...args], { maxBuffer: 8 << 20 });
  const reverted:string[] = [], failed:string[] = [];
  await withBaseLock(input.projectCwd, async () => {
    for (const path of input.paths) {
      if (path.startsWith("/") || path.split("/").includes("..")) { failed.push(path); continue; }
      try {
        const tracked = await git("cat-file", "-e", `HEAD:${path}`).then(() => true, () => false);
        if (tracked) await git("checkout", "HEAD", "--", path);
        else { await git("rm", "-q", "--cached", "--ignore-unmatch", "--", path); await rm(join(input.projectCwd, path), { recursive:true, force:true }); }
        reverted.push(path);
      } catch { failed.push(path); }
    }
  });
  return { reverted, failed };
}

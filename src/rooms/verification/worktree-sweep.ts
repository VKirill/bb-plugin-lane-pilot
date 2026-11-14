import { existsSync } from "node:fs";
import { readdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isFsAbsent, lstatOrNull, orMiss, spawnAsync } from "@lane-pilot/kit";
import { deleteBranchIfMerged, git, mergedAnywhere, mergeTargets, aheadOf, type MergedHow } from "./git-integrate";

/**
 * The daily worktree pass on one machine (docs/worktrees.md, SMA dt_wt_sweep): every linked worktree of the project repositories that
 * belongs to a swept class is read once and either removed with its branch, or kept with a reason the owner reads. The hourly janitor
 * (worktree-janitor.ts) keeps watching Lane Pilot's own root between passes; this pass also covers what that one never saw.
 *
 * Classes: `lane` — Lane Pilot's root (`~/.lane-pilot/worktrees`, either layout); `claude` — Claude Code subagents (`<repo>/.claude/worktrees`);
 * `dot-worktrees` — `<repo>/.worktrees`; `lp-phases` — phase candidates in `<repo>/.git/lp-phases`; `bb-env` — BB environment worktrees of
 * Lane Pilot attempts (the hub names them). Any other linked worktree (a person's release copy, a hand-made checkout) is not touched.
 *
 * Removed: merged into main (by ancestry, patch or squash) AND clean AND untouched for `maxAgeMs`; or belonging to an abandoned task (the
 * hub names those) AND clean — then the branch goes only when its work is merged, else it stays and is reported. Never removed: a worktree
 * an open attempt or live pass holds (`protectedPaths`), one whose folder or branch moved within `youngMs`, one locked by a live process,
 * one with uncommitted changes, one with commits merged nowhere. `git worktree prune` drops the entries whose folder is already gone.
 */
export const SWEEP_CLASSES = ["lane", "claude", "dot-worktrees", "lp-phases", "bb-env"] as const;
export type SweepClass = (typeof SWEEP_CLASSES)[number];
export type KeepReason = "protected" | "young" | "recent" | "locked" | "dirty" | "unmerged" | "error";
/** The reasons a person has to act on; the others (protected, young, recent) are only counted. */
export const REPORTED_KEEP_REASONS: readonly KeepReason[] = ["locked", "dirty", "unmerged", "error"];

export type SweepRemoved = { path: string; cls: SweepClass; bytes: number; branch: string | null; branchDeleted: boolean; why: "merged" | "abandoned"; how: MergedHow | "contained" | null };
export type SweepKept = { path: string; cls: SweepClass; reason: KeepReason; detail: string; bytes: number; ageMs: number; branch: string | null };
export type SweepReceipt = {
  removed: SweepRemoved[];
  freedBytes: number;
  kept: SweepKept[];
  /** Branches whose worktree went but whose commits are merged nowhere: never deleted. */
  branchesKept: Array<{ repo: string; branch: string; ahead: number; reason: string }>;
  /** Worktree entries whose folder was already gone, dropped by `git worktree prune`. */
  pruned: number;
  /** Paths of open registry rows (sent by the hub) whose folder is gone: the hub closes those rows. */
  registryGone: string[];
  repos: number;
  errors: string[];
  dryRun: boolean;
};

export type SweepInput = {
  laneRoot: string;
  /** Project folders on this machine: a repository top, or a folder holding repositories (two levels down are looked at). */
  folders: readonly string[];
  /** BB environment worktrees of Lane Pilot attempts on this machine (their repositories are found through them). */
  bbEnvPaths?: readonly string[];
  protectedPaths: ReadonlySet<string>;
  /** Worktrees of cancelled or abandoned tasks: removed when clean, their branch kept unless merged. */
  abandonedPaths?: ReadonlySet<string>;
  /** Paths of the registry's open rows on this machine. */
  registryPaths?: readonly string[];
  maxAgeMs: number;
  youngMs: number;
  now?: number;
  /** Read and decide only: nothing is removed, pruned or deleted (the receipt says what would be). */
  dryRun?: boolean;
  /** For tests: whether a pid is a live process (default: signal 0). */
  alive?: (pid: number) => boolean;
};

const MAX_REPOS = 500;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "__pycache__"]);

async function real(path: string): Promise<string> {
  return await orMiss(realpath(path), resolve(path), isFsAbsent);
}

async function dirBytes(path: string): Promise<number> {
  const du = await spawnAsync("du", ["-sk", path], { timeout: 300_000 });
  return du.status === 0 ? (Number.parseInt(du.stdout.trim().split(/\s/u)[0] ?? "", 10) || 0) * 1024 : 0;
}

const isRepoTop = async (path: string): Promise<boolean> => Boolean((await lstatOrNull(join(path, ".git")))?.isDirectory());

/** The repository a worktree folder belongs to (the parent of its common git dir), or null when it is no worktree. */
async function repoOfWorktree(path: string): Promise<string | null> {
  if (!(await lstatOrNull(join(path, ".git")))?.isFile()) return null;
  const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  return common && basename(common) === ".git" ? dirname(common) : null;
}

/** The repository tops to look in: each folder itself, else repositories up to two levels below it; plus the repositories of the given worktrees. */
export async function findSweepRepos(folders: readonly string[], worktrees: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (out.size >= MAX_REPOS) return;
    if (await isRepoTop(dir)) { out.add(await real(dir)); return; }
    if (depth === 0) return;
    for (const name of await orMiss(readdir(dir), [] as string[], isFsAbsent).catch(() => [] as string[])) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const child = join(dir, name);
      if ((await lstatOrNull(child))?.isDirectory()) await visit(child, depth - 1);
    }
  };
  for (const folder of folders) await visit(folder, 2);
  for (const path of worktrees) {
    const repo = await repoOfWorktree(path).catch(() => null);
    if (repo && out.size < MAX_REPOS) out.add(await real(repo));
  }
  return [...out].sort();
}

/** The worktree folders directly under Lane Pilot's root, in either layout (`<repo>/<id>` or `<id>/<repo>`). */
async function laneRootWorktrees(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const group of await orMiss(readdir(root), [] as string[], isFsAbsent)) {
    const dir = join(root, group);
    if (!(await lstatOrNull(dir))?.isDirectory()) continue;
    for (const name of await orMiss(readdir(dir), [] as string[], isFsAbsent).catch(() => [] as string[])) {
      const top = join(dir, name);
      if ((await lstatOrNull(join(top, ".git")))?.isFile()) out.push(top);
    }
  }
  return out;
}

type Entry = { path: string; head: string | null; branch: string | null; locked: string | null; prunable: boolean };
function parseWorktreeList(porcelain: string): Entry[] {
  return porcelain.split(/\n\n+/u).map((block) => block.split("\n")).filter((lines) => lines[0]?.startsWith("worktree ")).map((lines) => {
    const value = (key: string) => lines.find((line) => line === key || line.startsWith(`${key} `));
    const locked = value("locked");
    return {
      path: lines[0]!.slice("worktree ".length),
      head: value("HEAD")?.slice(5) ?? null,
      branch: value("branch")?.slice("branch refs/heads/".length) ?? null,
      locked: locked === undefined ? null : locked.slice("locked".length).trim(),
      prunable: value("prunable") !== undefined,
    };
  });
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}${sep}`);

function classOf(top: string, laneRoot: string, bbEnvs: readonly string[]): SweepClass | null {
  if (bbEnvs.some((env) => within(env, top) || within(top, env))) return "bb-env";
  if (within(top, laneRoot)) return "lane";
  if (top.includes(`${sep}.git${sep}lp-phases${sep}`)) return "lp-phases";
  if (top.includes(`${sep}.claude${sep}worktrees${sep}`)) return "claude";
  if (top.includes(`${sep}.worktrees${sep}`)) return "dot-worktrees";
  return null;
}

/** The newest moment the folder or its branch moved: the folder and its top entries, the worktree's own HEAD log, the branch's log. Never the index (a `git status` rewrites it). */
async function touchedAt(top: string, repo: string, branch: string | null): Promise<number> {
  let newest = 0;
  const seen = async (path: string) => { const info = await lstatOrNull(path); if (info) newest = Math.max(newest, info.mtimeMs); };
  await seen(top);
  for (const name of await orMiss(readdir(top), [] as string[], isFsAbsent).catch(() => [] as string[])) if (name !== ".git") await seen(join(top, name));
  const admin = (await git(top, ["rev-parse", "--path-format=absolute", "--git-dir"])).stdout.trim();
  if (admin) { await seen(join(admin, "logs", "HEAD")); await seen(join(admin, "HEAD")); }
  if (branch) { await seen(join(repo, ".git", "logs", "refs", "heads", ...branch.split("/"))); await seen(join(repo, ".git", "refs", "heads", ...branch.split("/"))); }
  return newest;
}

/** Uncommitted work: tracked edits and new files, without the links Lane Pilot itself puts in (node_modules) and other symlinks. */
async function uncommitted(top: string): Promise<number | null> {
  const status = await git(top, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!status.ok) return null;
  let count = 0;
  const parts = status.stdout.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]!;
    if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") index += 1;
    if (code === "??") {
      if (path.split("/")[0] === "node_modules") continue;
      if ((await lstatOrNull(join(top, path.replace(/\/$/u, ""))))?.isSymbolicLink()) continue;
    }
    count += 1;
  }
  return count;
}

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
};

export async function sweepWorktreeClasses(input: SweepInput): Promise<SweepReceipt> {
  const now = input.now ?? Date.now();
  const dry = input.dryRun === true;
  const alive = input.alive ?? defaultAlive;
  const receipt: SweepReceipt = { removed: [], freedBytes: 0, kept: [], branchesKept: [], pruned: 0, registryGone: [], repos: 0, errors: [], dryRun: dry };
  const laneRoot = await real(input.laneRoot);
  const bbEnvs = await Promise.all((input.bbEnvPaths ?? []).map(real));
  const protectedReal = await Promise.all([...input.protectedPaths].map(real));
  const abandonedReal = await Promise.all([...(input.abandonedPaths ?? [])].map(real));
  const touches = (top: string, list: readonly string[]) => list.some((path) => within(path, top) || within(top, path));

  const repos = await findSweepRepos(input.folders, [...await laneRootWorktrees(input.laneRoot), ...(input.bbEnvPaths ?? [])]);
  receipt.repos = repos.length;
  for (const repo of repos) {
    try {
      const listed = await git(repo, ["worktree", "list", "--porcelain"]);
      if (!listed.ok) { receipt.errors.push(`${repo}: git worktree list: ${listed.reason.slice(0, 200)}`); continue; }
      const entries = parseWorktreeList(listed.stdout);
      const prunable = entries.filter((entry) => entry.prunable && entry.locked === null).length;
      if (prunable) {
        if (!dry) await git(repo, ["worktree", "prune"]);
        receipt.pruned += prunable;
      }
      let targets: string[] | null = null;
      for (const entry of entries.slice(1)) {
        if (entry.prunable || !existsSync(entry.path)) continue;
        const top = await real(entry.path);
        const cls = classOf(top, laneRoot, bbEnvs);
        if (!cls) continue;
        const keep = (reason: KeepReason, detail: string, ageMs: number, bytes = 0) => { receipt.kept.push({ path: top, cls, reason, detail, bytes, ageMs, branch: entry.branch }); };
        try {
          if (touches(top, protectedReal)) { keep("protected", "an open attempt or a live pass holds it", 0); continue; }
          const ageMs = Math.max(0, now - await touchedAt(top, repo, entry.branch));
          if (ageMs < input.youngMs) { keep("young", "the folder or its branch moved within the last day", ageMs); continue; }
          let staleLock = false;
          if (entry.locked !== null) {
            const pid = Number(entry.locked.match(/\bpid[ =:]*(\d+)/iu)?.[1] ?? 0);
            if (!pid || alive(pid)) { keep("locked", entry.locked || "locked without a reason", ageMs, await dirBytes(top)); continue; }
            staleLock = true;
          }
          const dirty = await uncommitted(top);
          if (dirty === null) { keep("error", "git status failed", ageMs); continue; }
          if (dirty > 0) { keep("dirty", `${dirty} uncommitted change(s)`, ageMs, await dirBytes(top)); continue; }
          targets ??= await mergeTargets(repo);
          const ref = entry.branch ?? entry.head;
          if (!ref) { keep("error", "no HEAD", ageMs); continue; }
          let how: MergedHow | "contained" | null = (await mergedAnywhere(repo, ref, targets))?.how ?? null;
          // A detached copy (a gate's scratch, a review checkout) holds no work of its own when any branch or remote has its commit.
          if (!how && !entry.branch) {
            const holders = await git(repo, ["for-each-ref", "--contains", ref, "--format=%(refname)", "refs/heads", "refs/remotes"]);
            if (holders.ok && holders.stdout.trim()) how = "contained";
          }
          const abandoned = touches(top, abandonedReal);
          if (!how && !abandoned) { keep("unmerged", `${await aheadOf(repo, ref, targets)} commit(s) merged into none of ${targets.join(", ") || "(no main branch)"}`, ageMs, await dirBytes(top)); continue; }
          if (how && !abandoned && ageMs < input.maxAgeMs) { keep("recent", `merged (${how}), untouched for less than ${Math.round(input.maxAgeMs / 86_400_000)} day(s)`, ageMs); continue; }
          const bytes = await dirBytes(top);
          if (!dry) {
            if (staleLock) await git(repo, ["worktree", "unlock", top]);
            let gone = (await git(repo, ["worktree", "remove", "--force", top])).ok;
            if (!gone) gone = (await git(repo, ["worktree", "remove", "--force", "--force", top])).ok;
            if (!gone) { keep("error", "git worktree remove failed", ageMs, bytes); continue; }
            // The folder that held it under Lane Pilot's root (`<repo>/` now, `<id>/` before 0.1.561) goes when nothing else is in it.
            if (cls === "lane") await rmdir(dirname(top)).catch(() => undefined);
          }
          let branchDeleted = false;
          if (entry.branch) {
            if (how) {
              branchDeleted = dry ? !targets.includes(entry.branch) : (await deleteBranchIfMerged(repo, entry.branch, targets)).deleted;
            } else {
              const ahead = await aheadOf(repo, entry.branch, targets);
              receipt.branchesKept.push({ repo, branch: entry.branch, ahead, reason: `abandoned task: ${ahead} commit(s) merged nowhere, the branch stays` });
            }
          }
          receipt.removed.push({ path: top, cls, bytes, branch: entry.branch, branchDeleted, why: how ? "merged" : "abandoned", how });
          receipt.freedBytes += bytes;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          receipt.errors.push(`${top}: ${message.slice(0, 200)}`);
        }
      }
    } catch (cause) {
      receipt.errors.push(`${repo}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
    }
  }
  for (const path of input.registryPaths ?? []) if (!existsSync(path)) receipt.registryGone.push(path);
  return receipt;
}

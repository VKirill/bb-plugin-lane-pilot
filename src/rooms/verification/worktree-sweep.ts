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
export type KeepReason = "protected" | "live-thread" | "young" | "recent" | "locked" | "dirty" | "unmerged" | "no-environment-id" | "error";
/** The reasons a person has to act on; the others (protected, live thread, young, recent) are only counted. */
export const REPORTED_KEEP_REASONS: readonly KeepReason[] = ["locked", "dirty", "unmerged", "error"];
/** Why a linked worktree is only listed: outside the classes Lane Pilot owns the rule for, or a BB environment folder BB itself no longer lists. */
export type SkipReason = "outside" | "bb-env-unlisted";
export type DecisionReason = "merged" | "abandoned" | KeepReason | SkipReason;

/**
 * One line per linked worktree the pass looked at: what it decided and why. `remove` with `via: "bb"` is a BB environment: the machine never
 * removes it, the hub asks BB to (`environments.delete`). `skip` is never removed whatever its state; it carries the facts a person decides on.
 */
export type SweepDecision = {
  path: string; repo: string; cls: SweepClass | "outside"; decision: "remove" | "keep" | "skip"; reason: DecisionReason; detail: string;
  merged: MergedHow | "contained" | null; ageMs: number | null; dirty: number | null; unmerged: number | null; bytes: number; branch: string | null;
  via?: "git" | "bb"; environmentId?: string | null;
};

export type SweepRemoved = { path: string; cls: SweepClass; bytes: number; branch: string | null; branchDeleted: boolean; why: "merged" | "abandoned"; how: MergedHow | "contained" | null };
export type SweepKept = { path: string; cls: SweepClass; reason: KeepReason; detail: string; bytes: number; ageMs: number; branch: string | null };
export type SweepReceipt = {
  /** Removed by this machine (git). BB environments the hub is to remove are in `decisions` only (`via: "bb"`). */
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
  /** Every linked worktree looked at, with its decision. */
  decisions: SweepDecision[];
  /** The bounded search for repositories under the home folder: where, how deep, what it found, how long it took. */
  search?: { roots: string[]; maxDepth: number; repos: number; dirs: number; ms: number; truncated: boolean };
};

/** A BB environment on this machine as the hub knows it: its folder, its id, whether BB's own provider made it, whether a thread still lives in it. */
export type BbEnvironment = { path: string; environmentId: string | null; managed: boolean; live: boolean };

export type SweepInput = {
  laneRoot: string;
  /** Project folders on this machine: a repository top, or a folder holding repositories (two levels down are looked at). */
  folders: readonly string[];
  /** BB environment worktrees of Lane Pilot attempts (before 0.1.565; read as managed environments without an id). */
  bbEnvPaths?: readonly string[];
  /** The BB environments of this machine (0.1.565): a managed one with no live thread is class `bb-env`; a live one is kept wherever it is. */
  bbEnvs?: readonly BbEnvironment[];
  /** A bounded search for repositories (docs/worktrees.md): from each root, `maxDepth` levels, skipping dot folders, dependencies and caches. */
  search?: { roots: readonly string[]; maxDepth: number; maxRepos?: number; budgetMs?: number };
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
/** What the home search never enters, besides every dot folder (`.git`, `.cache`, `.npm`, `.claude`…) and symbolic links. */
const SEARCH_SKIP = new Set([...SKIP_DIRS, "Library", "snap", "go", "venv", "env", "coverage", "out", "tmp", "cache", "Caches", "Downloads", "Pictures", "Movies", "Music"]);
export const SEARCH_DEFAULTS = { maxDepth: 5, maxRepos: 2000, budgetMs: 180_000 } as const;

/**
 * The bounded search for repositories (docs/worktrees.md): from each root down `maxDepth` levels, a folder with a `.git` folder is a repository
 * (its subfolders are still looked at, nested repositories exist); a folder with a `.git` file is a linked worktree and is not entered (its
 * repository lists it); dot folders, symbolic links, dependencies and caches are never entered. Stops at `maxRepos` or after `budgetMs`.
 */
export async function searchRepos(roots: readonly string[], options: { maxDepth: number; maxRepos?: number; budgetMs?: number }): Promise<{ repos: string[]; dirs: number; ms: number; truncated: boolean }> {
  const started = Date.now();
  const maxRepos = options.maxRepos ?? SEARCH_DEFAULTS.maxRepos, budget = options.budgetMs ?? SEARCH_DEFAULTS.budgetMs;
  const repos = new Set<string>();
  let dirs = 0, truncated = false;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (repos.size >= maxRepos || Date.now() - started > budget) { truncated = true; return; }
    dirs += 1;
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const marker = children.find((child) => child.name === ".git");
    if (marker?.isFile()) return;
    // A `.git` folder without HEAD is no repository (OVH's home has one holding only a tool's id file).
    if (marker?.isDirectory() && existsSync(join(dir, ".git", "HEAD"))) repos.add(dir);
    if (depth >= options.maxDepth) return;
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith(".") || SEARCH_SKIP.has(child.name)) continue;
      await visit(join(dir, child.name), depth + 1);
    }
  };
  for (const root of roots) await visit(root, 0);
  return { repos: [...repos].sort(), dirs, ms: Date.now() - started, truncated };
}

async function real(path: string): Promise<string> {
  return await orMiss(realpath(path), resolve(path), isFsAbsent);
}

async function dirBytes(path: string): Promise<number> {
  const du = await spawnAsync("du", ["-sk", path], { timeout: 300_000 });
  return du.status === 0 ? (Number.parseInt(du.stdout.trim().split(/\s/u)[0] ?? "", 10) || 0) * 1024 : 0;
}

const isRepoTop = async (path: string): Promise<boolean> => Boolean((await lstatOrNull(join(path, ".git")))?.isDirectory()) && existsSync(join(path, ".git", "HEAD"));

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

/** The class of a linked worktree, by where it is; a managed BB environment (BB's or Lane Pilot's provider made it) wherever it is. */
function classOf(top: string, laneRoot: string, managedEnvs: readonly string[]): SweepClass | null {
  if (managedEnvs.some((env) => env === top)) return "bb-env";
  if (within(top, laneRoot)) return "lane";
  if (top.includes(`${sep}.git${sep}lp-phases${sep}`)) return "lp-phases";
  if (top.includes(`${sep}.claude${sep}worktrees${sep}`)) return "claude";
  if (top.includes(`${sep}.worktrees${sep}`)) return "dot-worktrees";
  return null;
}

/** The folder BB's git-worktree provider keeps its environments in (`<dataDir>/worktrees/<thread>-N/<repo>`, bb-core environment-git-worktree). */
const BB_ENV_FOLDER = `${sep}environment-git-worktree${sep}host-data${sep}worktrees${sep}`;

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
  const receipt: SweepReceipt = { removed: [], freedBytes: 0, kept: [], branchesKept: [], pruned: 0, registryGone: [], repos: 0, errors: [], dryRun: dry, decisions: [] };
  const laneRoot = await real(input.laneRoot);
  const envs: Array<BbEnvironment & { real: string }> = await Promise.all([
    ...(input.bbEnvs ?? []),
    ...(input.bbEnvPaths ?? []).map((path) => ({ path, environmentId: null, managed: true, live: false })),
  ].map(async (env) => ({ ...env, real: await real(env.path) })));
  const managedEnvs = envs.filter((env) => env.managed).map((env) => env.real);
  const protectedReal = await Promise.all([...input.protectedPaths].map(real));
  const abandonedReal = await Promise.all([...(input.abandonedPaths ?? [])].map(real));
  const touches = (top: string, list: readonly string[]) => list.some((path) => within(path, top) || within(top, path));

  let searched: string[] = [];
  if (input.search) {
    const found = await searchRepos(input.search.roots, input.search);
    searched = found.repos;
    receipt.search = { roots: [...input.search.roots], maxDepth: input.search.maxDepth, repos: found.repos.length, dirs: found.dirs, ms: found.ms, truncated: found.truncated };
  }
  const known = await findSweepRepos(input.folders, [...await laneRootWorktrees(input.laneRoot), ...envs.map((env) => env.path)]);
  const repos = [...new Set([...known, ...await Promise.all(searched.map(real))])].sort();
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
      const targetsOf = async () => (targets ??= await mergeTargets(repo));
      for (const entry of entries.slice(1)) {
        if (entry.prunable || !existsSync(entry.path)) continue;
        const top = await real(entry.path);
        const cls = classOf(top, laneRoot, managedEnvs);
        const env = envs.find((item) => item.real === top) ?? null;
        const base = { path: top, repo, branch: entry.branch, merged: null, ageMs: null, dirty: null, unmerged: null, bytes: 0 } as const;
        try {
          // A thread that is not archived still works in it (or in a folder inside it): kept, whatever its class.
          const liveEnv = envs.find((item) => item.live && within(item.real, top));
          if (!cls) {
            // Outside the classes Lane Pilot owns the rule for: only listed, with what a person decides on. A detached deploy copy can be merged and in use.
            const facts = await worktreeFacts(repo, top, entry, now, await targetsOf());
            const unlisted = top.includes(BB_ENV_FOLDER);
            receipt.decisions.push({ ...base, ...facts, cls: "outside", decision: "skip", reason: unlisted ? "bb-env-unlisted" : "outside",
              detail: `${unlisted ? "a BB environment folder BB no longer lists" : "outside the managed classes"}${liveEnv ? "; a live thread works in it" : ""}: ${describe(facts)}` });
            continue;
          }
          const keep = (reason: KeepReason, detail: string, facts: Partial<SweepDecision> & { ageMs: number }) => {
            const bytes = facts.bytes ?? 0;
            receipt.kept.push({ path: top, cls, reason, detail, bytes, ageMs: facts.ageMs, branch: entry.branch });
            receipt.decisions.push({ ...base, ...facts, bytes, cls, decision: "keep", reason, detail, ...(cls === "bb-env" ? { environmentId: env?.environmentId ?? null } : {}) });
          };
          if (touches(top, protectedReal)) { keep("protected", "an open attempt or a live pass holds it", { ageMs: 0 }); continue; }
          if (liveEnv) {
            // Kept whatever its state; its facts are read (read-only) so the owner sees what archiving the thread would let go.
            const facts = await worktreeFacts(repo, top, entry, now, await targetsOf());
            keep("live-thread", `a thread that is not archived works in it (${liveEnv.environmentId ?? "environment"}): ${describe(facts)}`, { ...facts, ageMs: facts.ageMs ?? 0 });
            continue;
          }
          const ageMs = Math.max(0, now - await touchedAt(top, repo, entry.branch));
          if (ageMs < input.youngMs) { keep("young", "the folder or its branch moved within the last day", { ageMs }); continue; }
          let staleLock = false;
          if (entry.locked !== null) {
            const pid = Number(entry.locked.match(/\bpid[ =:]*(\d+)/iu)?.[1] ?? 0);
            if (!pid || alive(pid)) { keep("locked", entry.locked || "locked without a reason", { ageMs, bytes: await dirBytes(top) }); continue; }
            staleLock = true;
          }
          const dirty = await uncommitted(top);
          if (dirty === null) { keep("error", "git status failed", { ageMs }); continue; }
          if (dirty > 0) { keep("dirty", `${dirty} uncommitted change(s)`, { ageMs, dirty, bytes: await dirBytes(top) }); continue; }
          const list = await targetsOf();
          const ref = entry.branch ?? entry.head;
          if (!ref) { keep("error", "no HEAD", { ageMs, dirty }); continue; }
          const how = await mergedHow(repo, ref, entry.branch, list);
          const abandoned = touches(top, abandonedReal);
          if (!how && !abandoned) {
            const ahead = await aheadOf(repo, ref, list);
            keep("unmerged", `${ahead} commit(s) merged into none of ${list.join(", ") || "(no main branch)"}`, { ageMs, dirty, unmerged: ahead, bytes: await dirBytes(top) });
            continue;
          }
          if (how && !abandoned && ageMs < input.maxAgeMs) { keep("recent", `merged (${how}), untouched for ${days(ageMs)} of ${days(input.maxAgeMs)}`, { ageMs, dirty, merged: how }); continue; }
          const bytes = await dirBytes(top);
          if (cls === "bb-env") {
            // BB's environment: BB removes it (environments.delete, which refuses while a thread is live), never this machine behind its back.
            if (!env?.environmentId) { keep("no-environment-id", "a BB environment the hub sent without its id: BB removes its environments", { ageMs, dirty, merged: how, bytes }); continue; }
            if (!how) { keep("unmerged", `abandoned, ${await aheadOf(repo, ref, list)} commit(s) merged nowhere: a BB environment goes only when merged`, { ageMs, dirty, merged: how, bytes }); continue; }
            receipt.decisions.push({ ...base, cls, decision: "remove", reason: "merged", detail: `merged (${how}), clean, untouched for ${days(ageMs)}: BB removes the environment`, merged: how, ageMs, dirty, unmerged: 0, bytes, via: "bb", environmentId: env.environmentId });
            continue;
          }
          if (!dry) {
            if (staleLock) await git(repo, ["worktree", "unlock", top]);
            let gone = (await git(repo, ["worktree", "remove", "--force", top])).ok;
            if (!gone) gone = (await git(repo, ["worktree", "remove", "--force", "--force", top])).ok;
            if (!gone) { keep("error", "git worktree remove failed", { ageMs, dirty, merged: how, bytes }); continue; }
            // The folder that held it under Lane Pilot's root (`<repo>/` now, `<id>/` before 0.1.561) goes when nothing else is in it.
            if (cls === "lane") await rmdir(dirname(top)).catch(() => undefined);
          }
          let branchDeleted = false, ahead = 0;
          if (entry.branch) {
            if (how) {
              branchDeleted = dry ? !list.includes(entry.branch) : (await deleteBranchIfMerged(repo, entry.branch, list)).deleted;
            } else {
              ahead = await aheadOf(repo, entry.branch, list);
              receipt.branchesKept.push({ repo, branch: entry.branch, ahead, reason: `abandoned task: ${ahead} commit(s) merged nowhere, the branch stays` });
            }
          }
          receipt.removed.push({ path: top, cls, bytes, branch: entry.branch, branchDeleted, why: how ? "merged" : "abandoned", how });
          receipt.decisions.push({ ...base, cls, decision: "remove", reason: how ? "merged" : "abandoned", merged: how, ageMs, dirty, unmerged: ahead, bytes, via: "git",
            detail: how ? `merged (${how}), clean, untouched for ${days(ageMs)}${entry.branch ? (branchDeleted ? "; its branch goes" : "; its branch stays") : ""}`
              : `abandoned task, clean${entry.branch ? `; branch ${entry.branch} stays (${ahead} commit(s) merged nowhere)` : ""}` });
          receipt.freedBytes += bytes;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          receipt.errors.push(`${top}: ${message.slice(0, 200)}`);
          receipt.decisions.push({ ...base, cls: cls ?? "outside", decision: cls ? "keep" : "skip", reason: "error", detail: message.slice(0, 200) });
        }
      }
    } catch (cause) {
      receipt.errors.push(`${repo}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
    }
  }
  for (const path of input.registryPaths ?? []) if (!existsSync(path)) receipt.registryGone.push(path);
  return receipt;
}

const days = (ms: number) => `${Math.floor(ms / 86_400_000)} day(s)`;

/** Merged into a target (ancestry, patch, squash); for a detached copy also «contained»: some branch or remote holds its commit. */
async function mergedHow(repo: string, ref: string, branch: string | null, targets: readonly string[]): Promise<MergedHow | "contained" | null> {
  const how = (await mergedAnywhere(repo, ref, targets))?.how ?? null;
  if (how || branch) return how;
  const holders = await git(repo, ["for-each-ref", "--contains", ref, "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return holders.ok && holders.stdout.trim() ? "contained" : null;
}

/** What a person reads about a copy outside the managed classes: merged or not, how many commits merged nowhere, age, uncommitted changes, size. */
async function worktreeFacts(repo: string, top: string, entry: Entry, now: number, targets: readonly string[]): Promise<Pick<SweepDecision, "merged" | "ageMs" | "dirty" | "unmerged" | "bytes">> {
  const ref = entry.branch ?? entry.head;
  const merged = ref ? await mergedHow(repo, ref, entry.branch, targets) : null;
  return {
    merged, ageMs: Math.max(0, now - await touchedAt(top, repo, entry.branch)), dirty: await uncommitted(top),
    unmerged: ref && !merged ? await aheadOf(repo, ref, targets) : 0, bytes: await dirBytes(top),
  };
}

const describe = (facts: Pick<SweepDecision, "merged" | "ageMs" | "dirty" | "unmerged">) =>
  `${facts.merged ? `merged (${facts.merged})` : `not merged (${facts.unmerged ?? "?"} commit(s))`}, ${facts.ageMs === null ? "age unknown" : `untouched for ${days(facts.ageMs)}`}, ${facts.dirty ?? "?"} uncommitted change(s)`;

import { lstat, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { git, orphanedWorktree } from "./git-integrate";

/** One worktree the sweep left: it holds work nobody else has (edits or commits on no other ref), or it is too young. */
export type JanitorKept = { path: string; reason: string; ageMs: number; bytes: number };
/** What one pass over ~/.lane-pilot/worktrees and Lane Pilot's tmp prefixes did. */
export type JanitorReceipt = {
  removed: string[];
  freedBytes: number;
  kept: JanitorKept[];
  tmpRemoved: string[];
  tmpFreedBytes: number;
  errors: string[];
};

/** The tmp folders Lane Pilot's own checks and drills make (mkdtemp prefixes across src/rooms). */
export const JANITOR_TMP_PREFIXES = ["lane-pilot-sandbox-", "lp-gate-base-", "lp-gate-bisect-", "lp-drill-", "lp-checkers-drill-"];
const TMP_MAX_AGE_MS = 24 * 3_600_000;

async function dirBytes(path: string): Promise<number> {
  const du = await spawnAsync("du", ["-sk", path], { timeout: 120_000 });
  if (du.status === 0) return (Number.parseInt(du.stdout.trim().split(/\s/)[0] ?? "", 10) || 0) * 1024;
  return 0;
}

/** The newest mtime the folder shows (top entry and its .git pointer): the age the grace is measured from. */
async function lastTouched(top: string): Promise<number> {
  let newest = 0;
  for (const entry of [top, join(top, ".git")]) {
    const info = await lstat(entry).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  // Files written inside (a check's log) age the copy too: a shallow scan two levels down, cheap on a dead worktree.
  for (const name of await readdir(top).catch(() => [] as string[])) {
    const info = await lstat(join(top, name)).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/**
 * A copy goes only when every commit of its HEAD already sits on a ref that is not the worktree's own lane/* branch
 * (any other local branch or a remote-tracking ref): `git branch --contains` on remotes and heads minus lane/*.
 */
async function uniqueCommits(top: string): Promise<boolean> {
  const refs = await git(top, ["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  if (!refs.ok) return true;
  return !refs.stdout.split("\n").some((ref) => ref && !ref.startsWith("refs/heads/lane/") && ref !== "refs/remotes/lane/");
}

/** Tracked-file edits only: a dead worktree's node_modules or dist writes are untracked noise, not work. */
async function hasEdits(top: string): Promise<boolean | null> {
  const status = await git(top, ["status", "--porcelain", "--untracked-files=no"]);
  return status.ok ? status.stdout.trim() !== "" : null;
}

/** Removes the worktree folder, its admin dir and its lane/* branch in the base repo it came from. */
async function removeCopy(top: string): Promise<boolean> {
  // The base's real git dir through the worktree pointer: <top>/.git says gitdir, <gitdir>/commondir says the shared dir.
  const pointer = (await readFile(join(top, ".git"), "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  let common = pointer ? (await readFile(join(pointer, "commondir"), "utf8").catch(() => "")).trim() : "";
  if (common && !common.startsWith("/") && pointer) common = join(dirname(pointer), common);
  const branch = common ? (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() : "";
  const removed = common ? (await git(common, ["worktree", "remove", "--force", top])).ok : false;
  if (!removed) await rm(top, { recursive: true, force: true }).catch(() => undefined);
  if (common) {
    if (!removed) await git(common, ["worktree", "prune"]);
    if (branch.startsWith("lane/")) await git(common, ["branch", "-D", branch]);
  }
  await rmdir(dirname(top)).catch(() => undefined);
  return true;
}

/**
 * One pass over Lane Pilot's worktree root: orphan folders go; worktrees an open attempt or task still holds (the
 * hub sends their paths), worktrees younger than `graceMs`, and worktrees holding uncommitted edits or commits that
 * no non-lane ref has stay — the last two are returned as `kept` for the morning line.
 */
export async function sweepLaneWorktrees(input: {
  root: string;
  protectedPaths: ReadonlySet<string>;
  graceMs: number;
  now?: number;
  tmpDir?: string;
  tmpPrefixes?: readonly string[];
  tmpMaxAgeMs?: number;
}): Promise<JanitorReceipt> {
  const now = input.now ?? Date.now();
  const receipt: JanitorReceipt = { removed: [], freedBytes: 0, kept: [], tmpRemoved: [], tmpFreedBytes: 0, errors: [] };
  const protectedReal = new Set<string>();
  for (const path of input.protectedPaths) protectedReal.add(await realpath(path).catch(() => path));
  const holds = async (top: string): Promise<boolean> => {
    const real = await realpath(top).catch(() => top);
    for (const path of protectedReal) if (path === real || path.startsWith(`${real}/`) || real.startsWith(`${path}/`)) return true;
    return false;
  };

  for (const group of await readdir(input.root).catch(() => [] as string[])) {
    const groupDir = join(input.root, group);
    if (!(await lstat(groupDir).catch(() => null))?.isDirectory()) continue;
    for (const name of await readdir(groupDir).catch(() => [] as string[])) {
      const top = join(groupDir, name);
      const info = await lstat(top).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      if (await holds(top)) continue;
      const bytes = await dirBytes(top);
      const ageMs = now - (await lastTouched(top));
      const retire = async (reason?: string): Promise<void> => {
        if (reason) receipt.kept.push({ path: top, reason, ageMs, bytes });
        else { receipt.removed.push(top); receipt.freedBytes += bytes; }
      };
      // A folder cut off from git (its .git names an admin dir git gave away, or has none) is retired, never asked git.
      const gitMarker = await lstat(join(top, ".git")).catch(() => null);
      if (!gitMarker) { await rm(top, { recursive: true, force: true }).catch(() => undefined); await rmdir(groupDir).catch(() => undefined); await retire(); continue; }
      const orphan = await orphanedWorktree(top);
      if (orphan) {
        await rename(join(orphan.top, ".git"), join(orphan.top, ".git.orphaned")).catch(() => undefined);
        await rm(orphan.top, { recursive: true, force: true }).catch(() => undefined);
        await rmdir(groupDir).catch(() => undefined);
        await retire();
        continue;
      }
      if (ageMs < input.graceMs) continue;
      const dirty = await hasEdits(top);
      if (dirty === null) { receipt.errors.push(`${top}: git status failed`); continue; }
      if (dirty) { await retire("uncommitted edits"); continue; }
      if (await uniqueCommits(top)) { await retire("commits no other branch or remote has"); continue; }
      await removeCopy(top);
      await retire();
    }
    await rmdir(groupDir).catch(() => undefined);
  }

  // Lane Pilot's own check/drill tmp folders older than a day go the same way, by prefix only.
  const tmpRoot = input.tmpDir ?? tmpdir();
  const prefixes = input.tmpPrefixes ?? JANITOR_TMP_PREFIXES;
  const tmpMaxAge = input.tmpMaxAgeMs ?? TMP_MAX_AGE_MS;
  for (const name of await readdir(tmpRoot).catch(() => [] as string[])) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(tmpRoot, name);
    const info = await lstat(path).catch(() => null);
    if (!info || now - info.mtimeMs < tmpMaxAge) continue;
    const bytes = await dirBytes(path);
    await rm(path, { recursive: true, force: true }).catch((cause: unknown) => { receipt.errors.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`); });
    receipt.tmpRemoved.push(path);
    receipt.tmpFreedBytes += bytes;
  }
  return receipt;
}

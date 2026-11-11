import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { isFsAbsent, spawnAsync } from "@lane-pilot/kit";
import { isBookkeepingPath } from "@lane-pilot/settings-catalog";
import { matchOwnsPath } from "@lane-pilot/kit";
import { isAllowedProjectLifePath } from "../../project-life";
import { git, identity } from "./git-core";

/** Files only machines write (receipts, episodes, locks): never the work of a task, whatever owns_paths names. */
const MACHINE_WRITTEN = [".agents/runs/", ".bb/chats/", "notes/lock/", ".agents/memory/episodes/"];
/** A bookkeeping path a task's owns_paths names; a catch-all pattern owns no particular file. */
function ownedBookkeeping(rel:string, owns:readonly string[]):boolean {
  const clean = rel.replace(/^\.\//, "");
  if (MACHINE_WRITTEN.some((prefix) => clean.startsWith(prefix))) return false;
  return owns.some((pattern) => pattern.trim() !== "**" && matchOwnsPath(clean, pattern));
}

/**
 * Bookkeeping folders sit in the repository's info/exclude (activation), so `git add -A` leaves out a file the task
 * owns there (`.agents/reports/audit.md`) and the work is lost with the worktree. Such files are added by force.
 */
export async function stageOwnedBookkeeping(worktreePath:string, owns:readonly string[], extra:readonly string[]):Promise<void> {
  const ignored=await git(worktreePath,["ls-files","--others","--ignored","--exclude-standard","-z"]);
  if(!ignored.ok) return;
  const files=ignored.stdout.split("\0").filter((file)=>file&&isBookkeepingPath(file,extra)&&ownedBookkeeping(file,owns));
  if(files.length) await git(worktreePath,["add","-f","--",...files]);
}

/** Paths staged in the base checkout's index (relative to the repository top), or null when git cannot say. */
export async function stagedPaths(basePath:string):Promise<string[]|null> {
  const staged=await git(basePath,["diff","--cached","--name-only","-z","HEAD"]);
  return staged.ok?staged.stdout.split("\0").filter(Boolean):null;
}

/**
 * Git's ort strategy refuses every merge while the index differs from HEAD, whatever the merge touches. The project-life
 * stage works in this checkout and stages its files (PROGRESS, CHANGELOG, plan items) a moment before it commits them
 * (drill 2026-10-07: the merge landed in that moment and failed as `merge_failed`). Machine-written files staged in the
 * base get `waitMs` to be committed by whoever staged them; still staged, they are committed here, as staged, under the
 * integration lock. Nothing is discarded, unstaged edits stay in the working tree, and a staged file that is anyone's
 * work (an owner's product file) is left alone: the merge then reports it as a dirty base.
 */
export async function settleStagedBookkeeping(basePath:string, extra:readonly string[], waitMs=20_000):Promise<void> {
  let paths=await stagedPaths(basePath);
  if(!paths?.length) return;
  const deadline=Date.now()+waitMs;
  while(paths?.length&&Date.now()<deadline) {
    await new Promise((resolve)=>setTimeout(resolve,250));
    paths=await stagedPaths(basePath);
  }
  if(!paths?.length) return;
  const prefix=(await git(basePath,["rev-parse","--show-prefix"])).stdout.trim();
  const machineWritten=(path:string)=>path.startsWith(prefix)&&(isBookkeepingPath(path.slice(prefix.length),extra)||isAllowedProjectLifePath(path.slice(prefix.length)));
  if(!paths.every(machineWritten)) return;
  const committed=await git(basePath,[...await identity(basePath),"commit","-q","-m","chore(progress): settle bookkeeping staged in the base before a merge"]);
  if(committed.ok) console.warn(`lane-pilot: committed ${paths.length} machine-written file(s) left staged in ${basePath} before the merge: ${paths.slice(0,5).join(", ")}`);
  else console.warn(`lane-pilot: could not commit the staged bookkeeping in ${basePath}: ${committed.reason.split("\n").slice(-3).join(" ")}`);
}

/**
 * The commit to merge in place of the writer's: its tree with every bookkeeping file (src/bookkeeping-paths.ts) set to
 * what main has. A hook or sibling agent edits those files in the base checkout meanwhile, and a merge that touched
 * them stopped on «local changes would be overwritten» or on a conflict nobody could redo away.
 */
export async function resolveBookkeepingToMain(basePath:string, sha:string, extra:readonly string[], owns:readonly string[]=[]):Promise<string> {
  const raw = await git(basePath, ["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "HEAD", sha]);
  if (!raw.ok) return sha;
  const prefix = (await git(basePath, ["rev-parse", "--show-prefix"])).stdout.trim();
  const parts = raw.stdout.split("\0");
  const entries:string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d+) \d+ ([0-9a-f]+) [0-9a-f]+ \w+$/.exec(parts[i] ?? "");
    const path = parts[i + 1]!;
    if (!meta || !path.startsWith(prefix) || !isBookkeepingPath(path.slice(prefix.length), extra)) continue;
    // A bookkeeping file the task owns (expected output `.agents/reports/audit.md`) is the task's work, not a hook's noise.
    if (ownedBookkeeping(path.slice(prefix.length), owns)) continue;
    // main's version (old side of the diff); a file main lacks is removed from the merged tree.
    entries.push(/^0+$/.test(meta[2]!) ? `0 ${meta[2]}\t${path}` : `${meta[1]} ${meta[2]}\t${path}`);
  }
  if (!entries.length) return sha;

  const gitDir = await git(basePath, ["rev-parse", "--absolute-git-dir"]);
  const dir = gitDir.ok && gitDir.stdout.trim() ? gitDir.stdout.trim() : join(basePath, ".git");
  const tempIndex = join(dir, `temp-idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  const run = (args:string[], input?:string) => spawnAsync("git", args, { cwd: basePath, env, timeout: 30_000, input });

  try {
    if ((await run(["read-tree", sha])).status !== 0) return sha;
    if ((await run(["update-index", "-z", "--index-info"], `${entries.join("\0")}\0`)).status !== 0) return sha;
    const writeTree = await run(["write-tree"]);
    if (writeTree.status !== 0 || !writeTree.stdout.trim()) return sha;
    const commitTree = await git(basePath, [...await identity(basePath), "commit-tree", writeTree.stdout.trim(), "-p", sha, "-m", "resolve bookkeeping to main"]);
    return commitTree.ok && commitTree.stdout.trim() ? commitTree.stdout.trim() : sha;
  } finally {
    try { unlinkSync(tempIndex); } catch (cause) { if (!isFsAbsent(cause)) throw cause; }
  }
}

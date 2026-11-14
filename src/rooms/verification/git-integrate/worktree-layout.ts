import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { git } from "./git-core";

/**
 * The worktree standard (docs/worktrees.md, SMA 4г): one place per machine, outside every repository, with names a person can read.
 * `<home>/.lane-pilot/worktrees/<repository>/<id>`: the repository's folder name, then the attempt or pass id (`lpattempt_…`,
 * `self-repair-…`, `docs-…`, `regress-…`, `gate-<sha8>-…`). Until 0.1.561 the order was `<id>/<repository>`; both are two levels deep,
 * so every sweep reads either, and an attempt that started before the deploy finishes and is removed where it stands.
 */
export const laneWorktreeRoot = (home?: string): string =>
  home ? join(home, ".lane-pilot", "worktrees") : process.env.LANE_PILOT_WORKTREE_ROOT?.trim() || join(homedir(), ".lane-pilot", "worktrees");

/** The repository's folder under the root: its own name, with nothing in it that would make a path (separators, a leading dot). */
export function repoFolderName(repoTop: string): string {
  const name = basename(repoTop.replace(/[\\/]+$/u, "")) || "repo";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\\/:]/gu, "_").replace(/^\.+/u, "_");
}

/** Where a new worktree of `repoTop` for `id` is made. */
export const laneWorktreeTarget = (root: string, repoTop: string, id: string): string => join(root, repoFolderName(repoTop), id);

/** How a ref's work is already in a target branch: its commits are there, the same patches are there (rebase, cherry-pick), or the whole branch is there as one commit (squash). */
export type MergedHow = "ancestor" | "patch-equivalent" | "squash";

/** The branches a repository's work lands on: main (else master) and the branch its own checkout has out, without repeats. */
export async function mergeTargets(repo: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of ["main", "master"]) {
    if ((await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${name}`])).ok) { out.push(name); break; }
  }
  // The repository's own checkout (a worktree's `commondir` parent): the branch writers merge into when it is not main.
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const own = common ? (await git(repo, [`--git-dir=${common}`, "symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim() : "";
  if (own && !out.includes(own)) out.push(own);
  return out;
}

/**
 * Whether the work of `ref` is already in `target`. Ancestry first; then `git cherry` (every commit has a patch-equivalent one in the
 * target: a rebase or a cherry-pick merge); then the squash probe — the patch id of the branch's whole change since its merge base,
 * compared with the patch ids of every commit the target got since then (read-only). Null: some of its work is nowhere in the target.
 */
export async function mergedInto(repo: string, ref: string, target: string): Promise<MergedHow | null> {
  if ((await git(repo, ["merge-base", "--is-ancestor", ref, target])).ok) return "ancestor";
  const cherry = await git(repo, ["cherry", target, ref]);
  if (cherry.ok) {
    const lines = cherry.stdout.split("\n").filter(Boolean);
    if (lines.length && lines.every((line) => line.startsWith("-"))) return "patch-equivalent";
  }
  const base = (await git(repo, ["merge-base", target, ref])).stdout.trim();
  const tip = (await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(base) || !/^[0-9a-f]{40,64}$/u.test(tip)) return null;
  // Read-only: nothing is written into the repository (a dry run on someone's checkout leaves no object behind).
  const ids = async (script: string) => {
    const ran = await spawnAsync("sh", ["-c", script, "sh", base, tip, target], { cwd: repo, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return ran.status === 0 ? ran.stdout.split("\n").map((line) => line.split(" ")[0]!).filter(Boolean) : [];
  };
  const [whole] = await ids(`git diff "$1" "$2" | git patch-id --stable`);
  if (!whole) return null;
  const landed = await ids(`git log -p --no-merges --format='commit %H' "$1..$3" | git patch-id --stable`);
  return landed.includes(whole) ? "squash" : null;
}

/** The first target `ref` is merged into, with how; null when none holds all of its work. */
export async function mergedAnywhere(repo: string, ref: string, targets?: readonly string[]): Promise<{ target: string; how: MergedHow } | null> {
  for (const target of targets ?? await mergeTargets(repo)) {
    const how = await mergedInto(repo, ref, target);
    if (how) return { target, how };
  }
  return null;
}

/** How many commits of `ref` no target has by ancestry (patch-equivalent ones included: this is the count a person reads). */
export async function aheadOf(repo: string, ref: string, targets: readonly string[]): Promise<number> {
  if (!targets.length) return 0;
  const counted = await git(repo, ["rev-list", "--count", ref, "--not", ...targets]);
  return counted.ok ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0;
}

/** The worktree folders that have `branch` checked out (`git worktree list --porcelain`). */
async function checkedOutAt(repo: string, branch: string): Promise<string[]> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return ["?"];
  return listed.stdout.split(/\n\n+/u).filter((block) => block.split("\n").includes(`branch refs/heads/${branch}`))
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "?");
}

/**
 * A branch goes only when its work is merged (by ancestry, patch or squash) into a target, and nothing has it checked out. A branch with
 * commits merged nowhere is never deleted: it is kept and named, with the count of its commits (the owner's rule, SMA 4г).
 */
export async function deleteBranchIfMerged(repo: string, branch: string, targets?: readonly string[]): Promise<{ deleted: boolean; how: MergedHow | null; reason: string | null; ahead: number }> {
  if (!(await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).ok) return { deleted: false, how: null, reason: null, ahead: 0 };
  const list = targets ?? await mergeTargets(repo);
  if (list.includes(branch)) return { deleted: false, how: null, reason: "it is a target branch", ahead: 0 };
  const holders = await checkedOutAt(repo, branch);
  if (holders.length) return { deleted: false, how: null, reason: `checked out at ${holders.join(", ")}`, ahead: 0 };
  const merged = await mergedAnywhere(repo, branch, list);
  if (!merged) {
    const ahead = await aheadOf(repo, branch, list);
    return { deleted: false, how: null, reason: list.length ? `${ahead} commit(s) merged into none of ${list.join(", ")}` : "the repository has no main branch to compare with", ahead };
  }
  const removed = await git(repo, ["branch", "-D", branch]);
  if (removed.ok) await git(repo, ["config", "--local", "--unset", `branch.${branch}.laneTask`]);
  return { deleted: removed.ok, how: merged.how, reason: removed.ok ? null : removed.reason, ahead: 0 };
}

import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The phase candidate (SMA p6_prepared → p6_authorized → p6_merge → p6_file_closed): the phase's pieces merge into its own branch
 * phase/<id>, not into main; the verification reads that tree, the acceptance decides on that package, and only then the branch at the
 * verified commit lands on main. Its worktree sits in the base checkout's own .git folder: inside the run folder, so a piece's
 * project_cwd may name it (taskBasePath, isTaskBase), and out of sight of every tool that walks the checkout (tests, linters, git status).
 */
export const CANDIDATE_DIR = ".git/lp-phases";
export const candidateBranch = (phaseId: string) => `phase/${phaseId}`;
export const candidatePath = (base: string, phaseId: string) => `${base.replace(/\/+$/, "")}/${CANDIDATE_DIR}/${phaseId}`;

export type CandidateTree = { path: string; startSha: string };
export type LandResult =
  | { state: "landed"; commit: string | null; mainBefore: string | null }
  | { state: "moved"; why: string }
  | { state: "conflict"; conflicts: string[]; why: string }
  | { state: "wait"; why: string };

type Host = { call(method: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<any> };

/** Shell run in the base checkout: the candidate worktree on phase/<id>, made once from the base's HEAD; prints its HEAD. */
export function candidateCommand(phaseId: string): string {
  const p = `${CANDIDATE_DIR}/${phaseId}`, b = candidateBranch(phaseId);
  return [
    `test -d .git || { echo "the checkout's .git is not a folder (a worktree, or no git): the phase cannot have its own branch here" >&2; exit 3; }`,
    `if [ ! -e "${p}/.git" ]; then git worktree prune; if git rev-parse --verify -q "refs/heads/${b}" >/dev/null; then git worktree add -q "${p}" "${b}" || exit 4; else git worktree add -q -b "${b}" "${p}" HEAD || exit 4; fi; fi`,
    `git -C "${p}" rev-parse HEAD`,
  ].join("\n");
}

export function createCandidates(host: Host, hostId: string) {
  const run = (cwd: string, command: string, timeoutSec = 60) => runOnHost(host as never, { hostId, cwd, command, timeoutSec }).catch((cause: unknown) => ({ exitCode: -1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));

  /** The candidate of a base checkout, made when missing and given the base's dependencies; a reason when the base cannot have one. */
  async function ensure(base: string, phaseId: string): Promise<CandidateTree | { off: string; permanent: boolean }> {
    const made = await run(base, candidateCommand(phaseId), 120);
    const sha = made.stdout.trim().split("\n").at(-1) ?? "";
    // Exit 3: the checkout cannot have a branch of its own (its .git is no folder) — that holds for good. Anything else (a full disk, a
    // host that did not answer) passes: the piece waits for the next pass instead of landing on main (SMA audit of C-03).
    if (made.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) return { off: (made.stderr || made.stdout || `exit ${made.exitCode}`).trim().slice(-300), permanent: made.exitCode === 3 };
    const path = candidatePath(base, phaseId);
    // The writers' worktrees take their node_modules from their base, which is now this tree: it gets the checkout's first.
    await host.call("gitPrepareWorktree", { requestedHostId: hostId, basePath: base, worktreePath: path }, { hostId, timeoutMs: 600_000 }).catch(() => undefined);
    return { path, startSha: sha };
  }

  async function head(path: string): Promise<string | null> {
    const ran = await run(path, "git rev-parse HEAD", 30);
    const sha = ran.stdout.trim();
    return ran.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
  }

  /**
   * Lands a verified candidate: main is taken into it first; a candidate that moved by that is not the package that was verified
   * (`moved`, verify again), one that does not merge names its files (`conflict`), a busy or dirty main waits; an up-to-date one merges.
   */
  async function land(base: string, tree: CandidateTree, verifiedSha: string, message: string, bookkeeping: string[]): Promise<LandResult> {
    const now = await head(tree.path);
    if (now !== verifiedSha) return { state: "moved", why: `the candidate is at ${now?.slice(0, 12) ?? "?"}, the verdict saw ${verifiedSha.slice(0, 12)}` };
    const synced = await host.call("gitSyncWorktree", { requestedHostId: hostId, basePath: base, worktreePath: tree.path }, { hostId, timeoutMs: 180_000 })
      .catch((cause: unknown) => ({ status: "failed", reason: cause instanceof Error ? cause.message : String(cause), conflicts: [] }));
    if (synced.status === "conflict") return { state: "conflict", conflicts: synced.conflicts ?? [], why: `main does not merge into the candidate: ${(synced.conflicts ?? []).join(", ") || synced.reason || "conflict"}` };
    if (synced.status === "synced") return { state: "moved", why: `main moved since the verdict and was merged into the candidate (now ${String(synced.head ?? "?").slice(0, 12)}): the new tree is verified again` };
    if (synced.status !== "up-to-date") return { state: "wait", why: `the candidate could not take main in: ${synced.status}${synced.reason ? ` (${synced.reason})` : ""}` };
    const merged = await host.call("gitIntegrate", { requestedHostId: hostId, basePath: base, worktreePath: tree.path, message, removeWorktree: false, committedOnly: true, bookkeeping, baseInHead: true, expectedHead: verifiedSha },
      { hostId, timeoutMs: 300_000 }).catch((cause: unknown) => ({ status: "failed", reason: cause instanceof Error ? cause.message : String(cause), conflicts: [], commit: null }));
    if (merged.status === "merged" || merged.status === "up-to-date") return { state: "landed", commit: merged.commit ?? null, mainBefore: merged.base ?? null };
    // Main moved between taking it in and the merge: the merge would not be the verified tree (SMA audit of C-03).
    if (merged.status === "failed" && String(merged.reason ?? "").startsWith("base moved since the candidate took it in")) return { state: "moved", why: `main moved during the landing: ${merged.reason}` };
    // The candidate got a commit after its head was read (SMA audit R-03): that commit is no part of the verified package.
    if (merged.status === "failed" && String(merged.reason ?? "").startsWith("the candidate moved since it was verified")) return { state: "moved", why: `the candidate moved during the landing: ${merged.reason}` };
    if (merged.status === "conflict") return { state: "conflict", conflicts: merged.conflicts ?? [], why: `the candidate does not merge into main: ${(merged.conflicts ?? []).join(", ")}` };
    return { state: "wait", why: `the landing waits: ${merged.status}${merged.reason ? ` (${merged.reason})` : ""}` };
  }

  /** The worktree goes once the branch landed; the branch phase/<id> stays as the record of the package. */
  async function drop(base: string, tree: CandidateTree): Promise<void> {
    await host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath: base, worktreePath: tree.path }, { hostId, timeoutMs: 60_000 }).catch(() => undefined);
  }

  return { ensure, head, land, drop };
}

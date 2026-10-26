/**
 * The revert of a merged night repair, as a function of the host: the plugin passes the real host, the tests a fake that checks every input
 * against the host contract (`hostContract`), so a value the host would refuse fails here too.
 */
export const FULL_COMMIT = /^[a-f0-9]{40,64}$/;
const ABBREVIATED_COMMIT = /^[a-f0-9]{7,39}$/;

export type RevertHost = { call(method: string, input: unknown, options: { hostId: string; timeoutMs: number }): Promise<unknown> };
export type RevertEnvironment = { hostId: string; basePath: string };

/**
 * The full SHA of a commit the repair row knows. The gate used to keep the first 12 characters of the merge in prose and hand those to
 * `gitRevertCommits`, which takes 40-64 hex only; an abbreviated one found in a stored row is resolved with git in the repository.
 */
export async function fullCommit(host: RevertHost, env: RevertEnvironment, commit: string): Promise<string | null> {
  if (FULL_COMMIT.test(commit)) return commit;
  if (!ABBREVIATED_COMMIT.test(commit)) return null;
  const out = await host.call("runCommand", { requestedHostId: env.hostId, cwd: env.basePath, timeoutSec: 30, command: `git rev-parse --verify --quiet ${commit}^{commit}` }, { hostId: env.hostId, timeoutMs: 40_000 }) as { exitCode: number; stdout: string };
  const full = out.stdout.trim();
  return out.exitCode === 0 && FULL_COMMIT.test(full) ? full : null;
}

/** Reverts `commit` in a fresh worktree and integrates the revert into the base checkout; the release train ships it. */
export async function revertMerge(host: RevertHost, env: RevertEnvironment, commit: string): Promise<{ ok: boolean; detail: string }> {
  const { hostId, basePath } = env;
  const full = await fullCommit(host, env, commit);
  if (!full) return { ok: false, detail: `commit ${commit.slice(0, 40)} is not a commit of ${basePath}` };
  const created = await host.call("gitCreateWorktree", { requestedHostId: hostId, basePath, name: `night-revert-${full.slice(0, 8)}-${Date.now().toString(36)}` }, { hostId, timeoutMs: 120_000 }) as { status: string; path?: string | null; reason?: string | null };
  if (created.status !== "ready" || !created.path) return { ok: false, detail: `worktree not created: ${created.reason ?? "unknown"}` };
  // The worktree goes away on every way out but a merged revert (which removes it itself): a revert refused by the host's input check left three of them
  // behind (night-revert-29754b58, -52dabb10, -8dd355f4 under ~/.lane-pilot/worktrees), and every retry would add one.
  const drop = () => host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath, worktreePath: created.path }, { hostId, timeoutMs: 120_000 }).catch(() => null);
  try {
    const reverted = await host.call("gitRevertCommits", { requestedHostId: hostId, worktreePath: created.path, commits: [full] }, { hostId, timeoutMs: 120_000 }) as { status: string; reason?: string | null; conflicts: string[] };
    if (reverted.status !== "reverted") {
      await drop();
      return { ok: false, detail: `${reverted.status}: ${reverted.reason ?? reverted.conflicts.join(", ")}` };
    }
    const merged = await host.call("gitIntegrate", { requestedHostId: hostId, basePath, worktreePath: created.path, message: `night loop: revert ${full.slice(0, 12)} (canary or bench red)`, removeWorktree: true }, { hostId, timeoutMs: 300_000 }) as { status: string; commit?: string | null; reason?: string | null };
    if (merged.status !== "merged") await drop();
    return { ok: merged.status === "merged", detail: `${merged.status}${merged.commit ? ` ${merged.commit.slice(0, 12)}` : ""}${merged.reason ? `: ${merged.reason}` : ""}` };
  } catch (cause) {
    await drop();
    throw cause;
  }
}

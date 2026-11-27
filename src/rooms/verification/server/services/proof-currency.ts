/**
 * Does a recorded proof still describe the code? A report keeps saying «proved» while its receipt points at a run many commits behind
 * (live 2026-10-26: the goal audit of a Roblox project worked out «the Shop files are unchanged since the release smoke» by hand from git).
 * This compares the proof's commit with HEAD over the paths the proof covers, with git only, and says which of five things is true.
 * Ported from the idea and the git rules of proof-currency in Matvey Maslov's agent-dev-tools (MIT); no dependency.
 *
 * - current: the commit is HEAD and the covered paths are clean.
 * - still about these paths: the commit is an ancestor of HEAD, the covered paths match it and are clean.
 * - stale: a covered path differs from the commit or has staged, unstaged or untracked changes; every such path is listed.
 * - not on this history: the commit is known but is not an ancestor of HEAD (rewritten, or another branch).
 * - unknown commit: the hash is not hex of 4 or more characters, names no commit here, or is ambiguous; nothing is compared.
 * It checks that the code did not move under the proof, not that the proof was sufficient. Only the history the checkout has is seen
 * (a change that was made and fully reverted in between is not reported), and ignored files are outside git status.
 */
import type { ProofCurrencyVerdict } from "@lane-pilot/contracts";
export type { ProofCurrencyVerdict };
export type ProofCurrencyResult = { verdict: ProofCurrencyVerdict; changedPaths: string[]; reason: string; resolvedCommit: string | null; head: string | null };

/** A git call in the checkout: the arguments after `git`. A non-zero exit is a result, not an error. */
export type GitRun = (args: readonly string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

const HEX = /^[0-9a-f]{4,64}$/i;

const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** Git on the project's host: the same arguments as one quoted command line for the host's shell (every argument is quoted). */
export function hostGit(run: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>): GitRun {
  return async (args) => {
    const done = await run(["git", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args].map(quote).join(" "));
    return { status: done.exitCode, stdout: done.stdout, stderr: done.stderr };
  };
}

/** A covered path as git spells it: `/` separators, no `./` or trailing slash. Absolute paths, `..` and empty strings are refused. */
function scopeOf(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!clean || /^([a-z]:)?\//i.test(clean) || clean.split("/").includes("..")) throw new RangeError(`Invalid covered path ${JSON.stringify(path)}: use a path inside the repository.`);
  return clean;
}

/** The paths of `git status --porcelain=v1 -z`; a rename or copy names both sides. */
function dirtyPaths(output: string): string[] {
  const fields = output.split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    if (!fields[i]) continue;
    out.push(fields[i]!.slice(3));
    if (/[RC]/.test(fields[i]!.slice(0, 2)) && fields[i + 1]) out.push(fields[++i]!);
  }
  return out;
}

/**
 * Checks whether a recorded receipt commit still proves the current tree across `paths` using
 * `git diff --name-only <commit>..HEAD -- <paths>` plus dirty working tree status.
 * Returns `"current" | "stale" | "not_on_history" | "unknown"` (never throws on an unreadable repo); only `"current"` counts as proof.
 */
export async function proofCurrency(input: {
  commit: string;
  paths?: readonly string[];
  git: GitRun;
  receiptId?: string;
  log?: (line: string) => void;
}): Promise<ProofCurrencyResult> {
  const emit = (result: ProofCurrencyResult): ProofCurrencyResult => {
    const id = input.receiptId ?? input.commit.slice(0, 12);
    input.log?.(`INFO proof.currency receipt=${id} verdict=${result.verdict} paths=${result.changedPaths.length}`);
    return result;
  };
  let scopes: string[];
  try {
    scopes = (input.paths ?? []).map(scopeOf).filter((scope) => scope !== ".");
  } catch (cause) {
    return emit({ verdict: "unknown", changedPaths: [], reason: cause instanceof Error ? cause.message : String(cause), resolvedCommit: null, head: null });
  }
  try {
    const headRun = await input.git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (headRun.status !== 0) return emit({ verdict: "unknown", changedPaths: [], reason: headRun.stderr.trim() || "checkout has no HEAD commit", resolvedCommit: null, head: null });
    const head = headRun.stdout.trim();
    if (!head) return emit({ verdict: "unknown", changedPaths: [], reason: "empty HEAD", resolvedCommit: null, head: null });
    if (!HEX.test(input.commit)) return emit({ verdict: "unknown", changedPaths: [], reason: "invalid commit hash", resolvedCommit: null, head });
    const resolved = await input.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.commit}^{commit}`]);
    if (resolved.status !== 0) return emit({ verdict: "unknown", changedPaths: [], reason: "unknown or ambiguous commit", resolvedCommit: null, head });
    const commit = resolved.stdout.trim();
    const anc = await input.git(["merge-base", "--is-ancestor", commit, head]);
    if (anc.status !== 0) {
      if (anc.status === 1) return emit({ verdict: "not_on_history", changedPaths: [], reason: "receipt commit is not an ancestor of HEAD", resolvedCommit: commit, head });
      return emit({ verdict: "unknown", changedPaths: [], reason: anc.stderr.trim() || `git merge-base exit ${anc.status}`, resolvedCommit: commit, head });
    }
    const statusRun = await input.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    if (statusRun.status !== 0) return emit({ verdict: "unknown", changedPaths: [], reason: statusRun.stderr.trim() || `git status exit ${statusRun.status}`, resolvedCommit: commit, head });
    const dirty = dirtyPaths(statusRun.stdout);
    let moved: string[] = [];
    if (commit !== head) {
      const diffArgs = ["diff", "--name-only", `${commit}..HEAD`, ...(scopes.length ? ["--", ...scopes] : [])];
      const diff = await input.git(diffArgs);
      if (diff.status !== 0) return emit({ verdict: "unknown", changedPaths: [], reason: diff.stderr.trim() || `git diff exit ${diff.status}`, resolvedCommit: commit, head });
      moved = diff.stdout.split(/\r?\n|\0/).map((s) => s.trim()).filter(Boolean);
    }
    const covered = (path: string) => !scopes.length || scopes.some((scope) => path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`));
    const changedPaths = [...new Set([...moved, ...dirty].filter(covered))].sort();
    if (changedPaths.length > 0) {
      return emit({ verdict: "stale", changedPaths, reason: "covered paths changed after receipt commit", resolvedCommit: commit, head });
    }
    return emit({ verdict: "current", changedPaths: [], reason: "covered paths unchanged since receipt commit", resolvedCommit: commit, head });
  } catch (cause) {
    return emit({ verdict: "unknown", changedPaths: [], reason: cause instanceof Error ? cause.message : String(cause), resolvedCommit: null, head: null });
  }
}

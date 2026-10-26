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
export type ProofVerdict = "current" | "still about these paths" | "stale" | "not on this history" | "unknown commit";

/** One proof: «at `commit` this was shown to hold for `paths`». No paths, or `.`, means every path. */
export type ProofRecord = { id: string; kind: string; commit: string; paths?: readonly string[] };

export type ProofResult = ProofRecord & { verdict: ProofVerdict; reason: string; changedPaths: string[]; resolvedCommit: string | null; head: string };

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

/** The verdict of every record against the checkout `git` looks at. Throws when git cannot run or the checkout has no HEAD commit. */
export async function checkProofs(records: readonly ProofRecord[], git: GitRun): Promise<ProofResult[]> {
  const scopes = records.map((record) => (record.paths ?? []).map(scopeOf).filter((scope) => scope !== "."));
  const headRun = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headRun.status !== 0) throw new Error(`The checkout has no HEAD commit: ${headRun.stderr.trim() || `git exit ${headRun.status}`}`);
  const head = headRun.stdout.trim();
  const statusRun = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (statusRun.status !== 0) throw new Error(`git status failed: ${statusRun.stderr.trim() || `exit ${statusRun.status}`}`);
  const dirty = dirtyPaths(statusRun.stdout);
  const diffs = new Map<string, string[]>();
  const results: ProofResult[] = [];
  for (const [index, record] of records.entries()) {
    const done = (verdict: ProofVerdict, reason: string, changedPaths: string[] = [], resolvedCommit: string | null = null): ProofResult => ({ ...record, verdict, reason, changedPaths, resolvedCommit, head });
    if (!HEX.test(record.commit)) { results.push(done("unknown commit", "Unknown or ambiguous commit: not a hexadecimal hash of 4 or more characters.")); continue; }
    // A missing hash exits 1; some git versions exit 128 for a short hash that matches several objects. Neither is an error here.
    const resolved = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${record.commit}^{commit}`]);
    if (resolved.status !== 0) { results.push(done("unknown commit", "Unknown or ambiguous commit: the hash does not name exactly one commit in this checkout (missing, shallow history, or a short hash that matches several); use the full hash.")); continue; }
    const commit = resolved.stdout.trim();
    if ((await git(["merge-base", "--is-ancestor", commit, head])).status !== 0) { results.push(done("not on this history", "The proof commit is not an ancestor of HEAD in the available history.", [], commit)); continue; }
    let moved = diffs.get(commit);
    if (!moved) {
      if (commit === head) moved = [];
      else {
        const diff = await git(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", commit, head, "--"]);
        if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr.trim() || `exit ${diff.status}`}`);
        moved = diff.stdout.split("\0").filter(Boolean);
      }
      diffs.set(commit, moved);
    }
    const mine = scopes[index]!;
    const covered = (path: string) => !mine.length || mine.some((scope) => path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`));
    const changed = [...new Set([...moved, ...dirty].filter(covered))].sort();
    if (changed.length) results.push(done("stale", "Covered paths differ from the proof commit or have uncommitted changes.", changed, commit));
    else if (commit === head) results.push(done("current", "The proof commit is HEAD and the covered paths are clean.", [], commit));
    else results.push(done("still about these paths", "The proof commit is an ancestor of HEAD; covered paths match and are clean.", [], commit));
  }
  return results;
}

/** The verdicts as lines for an auditor: one per proof, the changed paths cut after `maxPaths`, the whole text cut at `maxChars`. */
export function renderProofCurrency(results: readonly ProofResult[], options: { maxPaths?: number; maxChars?: number } = {}): string {
  if (!results.length) return "";
  const maxPaths = options.maxPaths ?? 8, maxChars = options.maxChars ?? 4000;
  const lines = results.map((result) => {
    const at = `${result.kind} ${result.id} @ ${result.commit.slice(0, 12)}`;
    const shown = result.changedPaths.slice(0, maxPaths).join(", ");
    const more = result.changedPaths.length > maxPaths ? ` (+${result.changedPaths.length - maxPaths} more)` : "";
    return result.verdict === "stale" ? `- ${at}: STALE, ${result.changedPaths.length} covered path(s) changed since: ${shown}${more}`
      : result.verdict === "not on this history" ? `- ${at}: NOT ON THIS HISTORY (the commit is not an ancestor of HEAD)`
      : result.verdict === "unknown commit" ? `- ${at}: UNKNOWN COMMIT (nothing compared)`
      : `- ${at}: ${result.verdict} (covered paths unchanged)`;
  });
  const head = results[0]!.head.slice(0, 12);
  const text = [`Computed by git at HEAD ${head}, not by a model. For each recorded proof: whether the code it covers moved after its commit.`, ...lines].join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 20)}\n- (cut)` : text;
}

type ProofDb = { prepare(sql: string): { all(...params: unknown[]): unknown[] } };

/**
 * The proofs of a phase's run that name a commit: every accepted attempt's merge commit with the files it changed, and the phase's
 * verification verdict and the run goal's verdict at the main they were taken on, each covering the files the run changed.
 */
export function phaseProofRecords(db: ProofDb, phase: { runId: string | null; record: { verification?: { verdict?: { mainSha?: string | null } } } }, goal: { headSha: string | null } | null): ProofRecord[] {
  if (!phase.runId) return [];
  const rows = db.prepare(`SELECT c.task_id AS task_id, c.merge_commit AS merge_commit, c.changed_json AS changed_json FROM lane_pilot_attempt_change c
    JOIN lane_pilot_attempt a ON a.id=c.attempt_id WHERE c.run_id=? AND a.state='accepted' AND c.merge_commit IS NOT NULL ORDER BY a.updated_at, a.rowid`).all(phase.runId) as Array<{ task_id: string; merge_commit: string; changed_json: string }>;
  const records: ProofRecord[] = [];
  const files = new Set<string>();
  for (const row of rows) {
    let changed: Array<{ path?: unknown }> = [];
    try { changed = JSON.parse(row.changed_json) as typeof changed; } catch { /* no files recorded */ }
    const paths = changed.map((file) => file.path).filter((path): path is string => typeof path === "string" && path.length > 0);
    if (!paths.length) continue;
    for (const path of paths) files.add(path);
    records.push({ id: row.task_id, kind: "accepted task, merge", commit: row.merge_commit, paths });
  }
  if (!files.size) return records;
  const all = [...files];
  const verdictSha = phase.record.verification?.verdict?.mainSha;
  if (verdictSha) records.push({ id: "of the phase", kind: "blind verification", commit: verdictSha, paths: all });
  if (goal?.headSha) records.push({ id: "of the run", kind: "run goal check", commit: goal.headSha, paths: all });
  return records;
}

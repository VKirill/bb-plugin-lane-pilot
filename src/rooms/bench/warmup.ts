import { mapVerificationCwd } from "../tasks";
import { q, type ExecResult, type HostPort } from "./ports";
import type { Candidate, VerificationItem, WarmRecord } from "./types";

/**
 * The warm-up of a candidate (SMA plan P0-1, risk «drift of repositories»): a task enters a set only when its accepted
 * solution, put on its base commit in a fresh clone, passes every check, and the bare base fails at least one of them. The checks that
 * fail on the base and pass with the solution are the ones that can tell good from bad. Nothing is judged by a model.
 */
export type WarmResult =
  | { ok: true; record: WarmRecord; solutionCommit: string; patchSha256: string }
  | { ok: false; reason: WarmReason; detail?: string };

export type WarmReason =
  | "base_unreachable" | "solution_commit_not_found" | "solution_ambiguous" | "solution_empty" | "solution_too_large" | "clone_failed"
  | "passes_on_base" | "solution_does_not_apply" | "solution_fails_checks" | "host_error";

export type WarmOptions = {
  /** A folder on the host for the clones, e.g. `$HOME/lp-bench/warm`. */
  scratch: string;
  keep?: boolean;
  /** Per-check cap in seconds (the contract's own `timeout_sec` when lower). */
  checkTimeoutSec?: number;
};

const tail = (result: ExecResult): string => `${result.stdout}\n${result.stderr}`.trim().slice(-300);
const slug = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
const MAX_PATCH_BYTES = 2_000_000;

/**
 * The `node_modules` folders of the live checkout, put into the clone so the checks find their dependencies. On macOS a copy-on-write clone
 * (`cp -Rc`, APFS: no extra disk, and no symlink that leaves the checkout, which Turbopack refuses); elsewhere a plain copy (`cp -a`). A symlink to the live
 * folder is wrong in a monorepo: its `node_modules/@scope/pkg -> ../../packages/pkg` links resolve from the real path, so the clone's checks would run
 * against the LIVE packages (and checks could write into the live node_modules). The gitignored `dist` of the workspace packages is copied the same way.
 */
export const linkDependenciesCommand = (repo: string, dir: string): string =>
  `cd ${q(repo)} && find . -maxdepth 4 -name node_modules -type d -prune -not -path '*/node_modules/*' | while read p; do t=${q(dir)}/"$p"; if [ ! -e "$t" ] && [ ! -L "$t" ]; then mkdir -p "$(dirname "$t")" && if [ "$(uname)" = Darwin ]; then cp -Rc ${q(repo)}/"$p" "$t"; else cp -a ${q(repo)}/"$p" "$t"; fi; fi; done`
  // The built outputs of the workspace packages (gitignored `dist`, ~40 MB in SelfyStudio) are not in a clone: `@scope/pkg` resolves to them. Taken from the live checkout (Linux only).
  + ` && { [ "$(uname)" = Darwin ] || { cd ${q(repo)} && find . -maxdepth 4 -name dist -type d -prune -not -path '*/node_modules/*' -not -path '*/.nuxt/*' | while read p; do t=${q(dir)}/"$p"; if [ ! -e "$t" ] && git check-ignore -q "$p"; then mkdir -p "$(dirname "$t")" && cp -a ${q(repo)}/"$p" "$t"; fi; done; }; }`;

async function runChecks(host: HostPort, hostId: string, candidate: Candidate, dir: string, options: WarmOptions): Promise<WarmRecord["base"]> {
  const out: WarmRecord["base"] = [];
  for (const item of candidate.contract.verification as VerificationItem[]) {
    const cwd = mapVerificationCwd(item.cwd, candidate.repoPath, dir) ?? dir;
    const timeout = Math.min(item.timeout_sec ?? 900, options.checkTimeoutSec ?? 1200);
    const result = await host.run(hostId, dir, `cd ${q(cwd)} && CI=1 ${item.command}`, timeout).catch((cause: unknown) => ({ exitCode: 255, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));
    out.push({ command: item.command, exitCode: result.exitCode, tail: tail(result) });
  }
  return out;
}

/** The commit that merged the accepted attempt: the attempt's trailer in the message, else the task id at the start of the subject (or after «Merge writer work: »). */
export async function findSolutionCommit(host: HostPort, candidate: Candidate): Promise<{ commit: string } | { reason: WarmReason; detail: string }> {
  const find = async (grep: string, fixed: boolean) => {
    // SelfyStudio's merges read «Merge writer work: <task id>: …»; its attempt branches hold the unmerged «<task id>: …» commits (three siblings are «ambiguous» without the merge).
    const greps = fixed ? [grep] : [grep, grep.replace(/^\^/, "^Merge writer work: ")];
    const result = await host.run(candidate.hostId, candidate.repoPath, `git log --all --format='%H %P' ${fixed ? "-F" : ""} ${greps.map((item) => `--grep=${q(item)}`).join(" ")}`, 60);
    if (result.exitCode !== 0) return { error: tail(result) };
    return { rows: result.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts[0] && /^[0-9a-f]{40}$/.test(parts[0])) };
  };
  for (const [grep, fixed] of [[`Lane-Pilot-Attempt: ${candidate.attemptId}`, true], [`^${candidate.taskId}: `, false]] as const) {
    const found = await find(grep, fixed);
    if ("error" in found) return { reason: "host_error", detail: found.error ?? "" };
    if (!found.rows.length) continue;
    const merges = found.rows.filter((parts) => parts.length > 2);
    if (merges.length >= 1) return { commit: merges[0]![0]! };
    if (found.rows.length === 1) return { commit: found.rows[0]![0]! };
    return { reason: "solution_ambiguous", detail: `${found.rows.length} commits carry the task's subject and none is a merge` };
  }
  return { reason: "solution_commit_not_found", detail: `no commit with trailer for ${candidate.attemptId} or subject ${candidate.taskId}:` };
}

export async function warmUp(host: HostPort, candidate: Candidate, options: WarmOptions): Promise<WarmResult> {
  const hostId = candidate.hostId, repo = candidate.repoPath;
  const git = (command: string, timeout = 120) => host.run(hostId, repo, command, timeout);
  const reachable = await git(`git cat-file -e ${q(`${candidate.initialHeadSha}^{commit}`)}`, 30).catch((cause: unknown) => ({ failed: cause instanceof Error ? cause.message : String(cause) }));
  if ("failed" in reachable) return { ok: false, reason: "host_error", detail: `the host did not answer: ${reachable.failed}` };
  if (reachable.exitCode !== 0) return { ok: false, reason: "base_unreachable", detail: candidate.initialHeadSha };
  const solution = await findSolutionCommit(host, candidate);
  if ("reason" in solution) return { ok: false, reason: solution.reason, detail: solution.detail };
  const work = `${options.scratch}/${slug(candidate.taskId)}-${Date.now().toString(36)}`;
  const dir = `${work}/clone`, patch = `${work}/solution.patch`;
  try {
    const made = await host.run(hostId, "/", `mkdir -p ${q(work)} && git -C ${q(repo)} diff --binary ${q(`${solution.commit}^1`)} ${q(solution.commit)} > ${q(patch)} && wc -c < ${q(patch)}`, 120);
    if (made.exitCode !== 0) return { ok: false, reason: "host_error", detail: tail(made) };
    const bytes = Number(made.stdout.trim());
    if (!bytes) return { ok: false, reason: "solution_empty", detail: solution.commit };
    if (bytes > MAX_PATCH_BYTES) return { ok: false, reason: "solution_too_large", detail: `${bytes} bytes` };
    const hash = await host.run(hostId, "/", `(sha256sum ${q(patch)} 2>/dev/null || shasum -a 256 ${q(patch)}) | cut -d' ' -f1; git -C ${q(repo)} diff --name-only ${q(`${solution.commit}^1`)} ${q(solution.commit)} | head -200`, 60);
    const [patchSha256 = "", ...files] = hash.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const cloned = await host.run(hostId, "/", `git clone -q --local --no-checkout ${q(repo)} ${q(dir)} && git -C ${q(dir)} checkout -q --detach ${q(candidate.initialHeadSha)} && ${linkDependenciesCommand(repo, dir)}`, 900);
    if (cloned.exitCode !== 0) return { ok: false, reason: "clone_failed", detail: tail(cloned) };

    const base = await runChecks(host, hostId, candidate, dir, options);
    if (base.every((row) => row.exitCode === 0)) return { ok: false, reason: "passes_on_base", detail: "every check already passes on the bare base" };

    let applied: WarmRecord["applied"] = "apply";
    let result = await host.run(hostId, dir, `git apply --index --whitespace=nowarn ${q(patch)}`, 120);
    if (result.exitCode !== 0) {
      applied = "3way";
      result = await host.run(hostId, dir, `git apply --index --3way --whitespace=nowarn ${q(patch)}`, 120);
      if (result.exitCode !== 0) return { ok: false, reason: "solution_does_not_apply", detail: tail(result) };
    }
    const withSolution = await runChecks(host, hostId, candidate, dir, options);
    const failing = withSolution.find((row) => row.exitCode !== 0);
    if (failing) return { ok: false, reason: "solution_fails_checks", detail: `${failing.command} exit ${failing.exitCode}: ${failing.tail}` };
    const discriminating = base.filter((row, index) => row.exitCode !== 0 && withSolution[index]!.exitCode === 0).map((row) => row.command);
    return { ok: true, solutionCommit: solution.commit, patchSha256, record: { base, solution: withSolution, discriminating, applied, files } };
  } finally {
    if (!options.keep) await host.run(hostId, "/", `rm -rf ${q(work)}`, 300).catch(() => undefined);
  }
}

/**
 * Free space (GB) a host needs before the bench touches it. Lane Pilot's own writers hold at min(15 GB, 5%) free (memory mac-mini-disk-test-temp);
 * the bench keeps 10 GB above that, so a warm-up clone can never be what stops the writers.
 */
export const MIN_FREE_GB = 25;

/** Free space in GB on the host's home volume. */
export async function freeGb(host: HostPort, hostId: string): Promise<number | null> {
  const result = await host.run(hostId, "/", `df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}'`, 30).catch(() => null);
  const value = Number(result?.stdout.trim());
  return result && result.exitCode === 0 && Number.isFinite(value) ? value : null;
}

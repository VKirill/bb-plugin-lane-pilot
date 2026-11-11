/**
 * The git facts of the tracked files, read once: one `git log` walk gives every file its newest commit
 * and its commit count. Missing or unreadable repos return empty facts (the caller stays fail-open).
 */
import { spawnSync } from "node:child_process";

import type { GitFacts } from "./card";

/** Newest commit and commit count per tracked path, in one `git log` pass over the newest 2000 commits. */
export function collectGitFacts(cwd: string, paths: readonly string[], warn: (message: string) => void = () => undefined): Map<string, GitFacts> {
  const facts = new Map<string, GitFacts>();
  const wanted = new Set(paths);
  const log = spawnSync("git", ["log", "--max-count=2000", "--format=commit %H", "--name-only", "--"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
  // A repo with no commits or a git that failed is not an error to stop for, but the cards then carry no commit facts: say so.
  if (log.status !== 0 || !log.stdout) {
    warn(`git log failed (${log.error?.message ?? `status ${log.status}`}${log.stderr ? `: ${String(log.stderr).trim().slice(0, 200)}` : ""}); cards carry no commit facts`);
    return facts;
  }
  let commit: string | null = null;
  for (const line of (log.stdout as string).split("\n")) {
    const head = /^commit ([0-9a-f]{7,64})$/.exec(line.trim());
    if (head) { commit = head[1]!; continue; }
    const path = line.trim();
    if (!commit || !path || !wanted.has(path)) continue;
    const fact = facts.get(path);
    if (fact) fact.commits += 1;
    else facts.set(path, { lastCommit: commit, commits: 1 });
  }
  return facts;
}

/** The git-tracked paths of a checkout, one `git ls-files` call. */
export function trackedFiles(cwd: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
  if (listed.status !== 0 || !listed.stdout) return [];
  return (listed.stdout as Buffer).toString("utf8").split("\0").filter(Boolean);
}

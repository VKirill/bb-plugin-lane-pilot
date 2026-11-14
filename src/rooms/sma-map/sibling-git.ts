// Read-only git reads of a sibling repository (siblings.ts) at a named commit: the contract index, the change points and
// the attestations read the sibling from its object database, never from a working tree, so the result does not depend on
// which branch a shared checkout has out. Used by scripts (sma-contracts, sma-provenance, sma-mutate), not by the plugin.
import { execFileSync } from "node:child_process";

const git = (root: string, args: readonly string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (root: string, args: readonly string[]): string | null => { try { return git(root, args); } catch { return null; } };

/** HEAD of the checkout (12 characters), or null. */
export const headOf = (root: string): string | null => tryGit(root, ["rev-parse", "HEAD"])?.trim().slice(0, 12) ?? null;
/** Whether the checkout has uncommitted changes to tracked files. */
export const isDirty = (root: string): boolean => !!tryGit(root, ["status", "--porcelain", "--untracked-files=no"])?.trim();
/** Whether `commit` is in the repository's object database (every worktree of a repository shares it). */
export const hasCommit = (root: string, commit: string): boolean => tryGit(root, ["cat-file", "-e", `${commit}^{commit}`]) !== null;
/** Whether `ancestor` is contained in `descendant`. */
export const isAncestor = (root: string, ancestor: string, descendant: string): boolean => tryGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
/** What `path` is at `commit`: a file (blob), a folder (tree), or nothing (null). */
export const kindAt = (root: string, commit: string, path: string): "blob" | "tree" | null => { const kind = tryGit(root, ["cat-file", "-t", `${commit}:${path.replace(/\/$/, "")}`])?.trim(); return kind === "blob" || kind === "tree" ? kind : null; };
/** The file's text at `commit`, or null when it has no such file (a folder is not a file). */
export const showAt = (root: string, commit: string, path: string): string | null => (kindAt(root, commit, path) === "blob" ? tryGit(root, ["show", `${commit}:${path}`]) : null);
/** Files under the pathspecs at `commit` whose text matches the extended regex `pattern`. */
export function grepFilesAt(root: string, commit: string, pathspecs: readonly string[], pattern: string): string[] {
  const out = tryGit(root, ["grep", "-l", "-I", "-E", pattern, commit, "--", ...pathspecs]);
  return (out ?? "").split("\n").filter(Boolean).map((line) => line.slice(line.indexOf(":") + 1)).sort();
}
/** Per line (1-based) of `path` at `commit`: the commit that last changed it and its committer time (ms). */
export function blameAt(root: string, commit: string, path: string): Array<{ commit: string; time: number }> | null {
  const blamed = tryGit(root, ["blame", "--porcelain", commit, "--", path]);
  if (blamed === null) return null;
  const lines: Array<{ commit: string; time: number }> = [];
  const times = new Map<string, number>();
  let current = "";
  for (const line of blamed.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) { current = head[1]!; lines[Number(head[2])] = { commit: current, time: 0 }; continue; }
    const time = /^committer-time (\d+)/.exec(line);
    if (time) times.set(current, Number(time[1]) * 1000);
  }
  for (const entry of lines) if (entry) entry.time = times.get(entry.commit) ?? 0;
  return lines;
}
/** The last commit at or before `commit` that touched `path`, with its time (ms). */
export function lastCommitAt(root: string, commit: string, path: string): { commit: string; time: number } | null {
  const out = tryGit(root, ["log", "-1", "--format=%H %ct", commit, "--", path])?.trim();
  return out ? { commit: out.split(" ")[0]!, time: Number(out.split(" ")[1]) * 1000 } : null;
}

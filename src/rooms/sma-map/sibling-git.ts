// Read-only git reads of a sibling repository (siblings.ts) at a named commit: the contract index, the change points and
// the attestations read the sibling from its object database, never from a working tree, so the result does not depend on
// which branch a shared checkout has out; and the frozen identity (snapshotOf/frozenChanges) the mutation runner checks a
// checkout against before and after a mutation. Used by scripts (sma-contracts, sma-provenance, sma-mutate), not by the plugin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const git = (root: string, args: readonly string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (root: string, args: readonly string[]): string | null => { try { return git(root, args); } catch { return null; } };

/** HEAD of the checkout (12 characters), or null. */
export const headOf = (root: string): string | null => tryGit(root, ["rev-parse", "HEAD"])?.trim().slice(0, 12) ?? null;
/** Whether the checkout has uncommitted changes to tracked files. */
export const isDirty = (root: string): boolean => !!tryGit(root, ["status", "--porcelain", "--untracked-files=no"])?.trim();
/**
 * The `paths` whose bytes on disk are not the blob `commit` has for them (or that `commit` has no blob for) — read from the
 * bytes, so a file git status hides (assume-unchanged, skip-worktree) still counts — or null when git cannot say.
 */
export function differFromCommit(root: string, commit: string, paths: readonly string[]): string[] | null {
  if (!paths.length) return [];
  const disk = tryGit(root, ["hash-object", "--no-filters", "--", ...paths])?.trim().split("\n");
  if (!disk || disk.length !== paths.length) return null;
  return paths.filter((path, at) => tryGit(root, ["rev-parse", "--verify", "-q", `${commit}:${path}`])?.trim() !== disk[at]);
}
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

// ---- the frozen identity of a checkout the mutation runner works in (scripts/sma-mutate.mjs) ----
/** HEAD, its tree, and every path git status names (tracked changes, untracked files git does not ignore) with its status
 * and a hash of its bytes; `keep` paths also carry their text. */
export type Snapshot = { root: string; head: string; tree: string; entries: Record<string, { sig: string; text?: string | null }> };
const bytesSig = (file: string): string => {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (info.isDirectory()) return "dir";
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch { return "missing"; }
};
const textOrNull = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
/** The checkout's state now, or null when git cannot be read (never taken for «clean»). */
export function snapshotOf(root: string, keep: (path: string) => boolean = () => false): Snapshot | null {
  const head = tryGit(root, ["rev-parse", "HEAD"])?.trim();
  const tree = tryGit(root, ["rev-parse", "HEAD^{tree}"])?.trim();
  const status = tryGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!head || !tree || status === null) return null;
  const entries: Snapshot["entries"] = {};
  const parts = status.split("\0");
  for (let at = 0; at < parts.length; at++) {
    const item = parts[at]!;
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    const path = item.slice(3);
    if (code[0] === "R" || code[0] === "C") at++; // -z puts a rename's source path in the next part
    entries[path] = { sig: `${code} ${bytesSig(join(root, path))}`, ...(keep(path) ? { text: textOrNull(join(root, path)) } : {}) };
  }
  return { root, head, tree, entries };
}
/**
 * What changed from `start` to `end`: HEAD, its tree, or a path whose status or bytes differ — less the paths `allow`
 * permits (given the path's text before and after; a path clean at one end is read from that end's HEAD).
 */
export function frozenChanges(start: Snapshot, end: Snapshot, allow?: (path: string, before: string | null, after: string | null) => boolean): string[] {
  const changed: string[] = [];
  if (start.head !== end.head) changed.push(`HEAD ${start.head.slice(0, 12)} → ${end.head.slice(0, 12)}`);
  if (start.tree !== end.tree) changed.push("the tree of HEAD");
  for (const path of new Set([...Object.keys(start.entries), ...Object.keys(end.entries)])) {
    if (start.entries[path]?.sig === end.entries[path]?.sig) continue;
    if (allow) {
      const before = start.entries[path] ? start.entries[path]!.text ?? null : showAt(start.root, start.head, path);
      const after = end.entries[path] ? end.entries[path]!.text ?? null : showAt(end.root, end.head, path);
      if (allow(path, before, after)) continue;
    }
    changed.push(path);
  }
  return changed;
}
/** Whether two JSON object texts differ only in the listed top-level keys; a text that is not a JSON object never does. */
export function onlyKeysChanged(before: string | null, after: string | null, keys: ReadonlySet<string>): boolean {
  const parse = (text: string | null): Record<string, unknown> | null => {
    try { const value: unknown = JSON.parse(text ?? ""); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
  };
  const a = parse(before), b = parse(after);
  if (!a || !b) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!keys.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  return true;
}

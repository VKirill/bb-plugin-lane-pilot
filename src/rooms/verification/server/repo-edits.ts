import type { ServerCore } from "../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The files `git status` lists in a checkout, read on the machine that holds it (the PM's environment may sit on another
 * host than the hub, so the hub never runs git on its path). Null when the host could not say: no snapshot then, and no
 * false «helper edited files» from a half-read one.
 */
const porcelainPaths = (stdout: string): Set<string> => {
  const files = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const name = trimmed.slice(2).trim();
    if (name) files.add(name.split(" -> ").pop()!.trim());
  }
  return files;
};

export async function gitRepoStatus(host: ServerCore["host"], hostId: string, cwd: string): Promise<Set<string> | null> {
  const ran = await bestEffort(console.warn, `repo status ${hostId} ${cwd}`, runOnHost(host, { hostId, cwd, command: "git status --porcelain -uall", timeoutSec: 30, timeoutMs: 45_000 }), null);
  if (!ran || ran.exitCode !== 0) return null;
  return porcelainPaths(ran.stdout);
}

/**
 * What one edge of a helper's window looked like in the checkout: HEAD, the porcelain filenames and a hash of each
 * tracked diff (`git diff` worktree-vs-index, `git diff --cached` index-vs-HEAD). Endpoint observations only — untracked
 * file bytes are unverified (names only), a write+revert inside the window is invisible, and nothing here proves the
 * run left no other effect. Null when the host could not answer or the output lost its end sentinel.
 */
export type RepoSnapshot = {
  /** Hub clock when the snapshot was asked for (the host's own clock may differ). */
  at: number;
  hostId: string;
  root: string;
  /** `git rev-parse HEAD`, hex 40 (SHA-1) or 64 (SHA-256); null on an unborn branch, a malformed answer or when git could not say. */
  head: string | null;
  /** `git status --porcelain -uall` paths, same parse as `gitRepoStatus`. */
  files: string[];
  /** `git hash-object` (`hashAlgorithm`) of `git diff --no-ext-diff --no-textconv --binary`; null when that diff failed. */
  workDiffHash: string | null;
  /** Same over `git diff --cached`; null when it failed (e.g. unborn HEAD). */
  indexDiffHash: string | null;
  /** The object format `git hash-object` answers in on this repository. */
  hashAlgorithm: "git-object";
};

/**
 * One host call that measures a checkout's state: each `git diff` is captured to a temp file and hashed only after the
 * diff itself succeeded (a pipeline would hide its failure behind `hash-object`'s), and `===END===` proves the output
 * was not cut. A failed `git status` fails the whole snapshot — the file list is the part the edit guard needs.
 */
const REPO_SNAPSHOT_COMMAND = [
  'tmp=$(mktemp "${TMPDIR:-/tmp}/lp-repo-snap.XXXXXX" 2>/dev/null) || { echo "SNAPSHOT_FAIL mktemp"; exit 0; }',
  'head=$(git rev-parse HEAD 2>/dev/null || true)',
  'printf "\\n===HEAD===\\n%s\\n===STATUS===\\n" "$head"',
  'git status --porcelain -uall || { rm -f "$tmp"; echo "SNAPSHOT_FAIL status"; exit 0; }',
  'git diff --no-ext-diff --no-textconv --binary > "$tmp" 2>/dev/null && worksha=$(git hash-object --no-filters "$tmp" 2>/dev/null || true) || worksha=',
  'printf "===WORKSHA===\\n%s\\n===INDEXSHA===\\n" "$worksha"',
  'git diff --cached --no-ext-diff --no-textconv --binary > "$tmp" 2>/dev/null && idxsha=$(git hash-object --no-filters "$tmp" 2>/dev/null || true) || idxsha=',
  'rm -f "$tmp"',
  'printf "%s\\n===END===\\n" "$idxsha"',
].join("\n");

const SNAPSHOT_MARKS = ["===HEAD===", "===STATUS===", "===WORKSHA===", "===INDEXSHA===", "===END==="] as const;
const GIT_HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export async function gitRepoSnapshot(host: ServerCore["host"], hostId: string, cwd: string): Promise<RepoSnapshot | null> {
  const at = Date.now();
  const ran = await bestEffort(console.warn, `repo snapshot ${hostId} ${cwd}`, runOnHost(host, { hostId, cwd, command: REPO_SNAPSHOT_COMMAND, timeoutSec: 30, timeoutMs: 45_000 }), null);
  if (!ran || ran.exitCode !== 0) return null;
  // Markers count only as whole lines: a porcelain filename may contain the marker text without being one.
  const lines = ran.stdout.split("\n");
  if (lines.some((line) => line.startsWith("SNAPSHOT_FAIL "))) return null;
  const pos: number[] = [];
  let from = 0;
  for (const mark of SNAPSHOT_MARKS) {
    const i = lines.findIndex((line, at2) => at2 >= from && line === mark);
    if (i < 0) return null;
    pos.push(i);
    from = i + 1;
  }
  // Nothing but blank lines may follow the end sentinel.
  if (lines.slice(pos[4]! + 1).some((line) => line.trim() !== "")) return null;
  const between = (a: number, b: number) => lines.slice(pos[a]! + 1, pos[b]).join("\n").trim();
  const hash = (value: string) => (GIT_HASH.test(value) ? value : null);
  return {
    at, hostId, root: cwd, hashAlgorithm: "git-object",
    head: hash(between(0, 1)) || null,
    files: [...porcelainPaths(lines.slice(pos[1]! + 1, pos[2]).join("\n"))],
    workDiffHash: hash(between(2, 3)) || null,
    indexDiffHash: hash(between(3, 4)) || null,
  };
}

export function detectRepoEdits(before: Set<string>, after: Set<string>, allowed: (file: string) => boolean): string[] {
  const changed: string[] = [];
  for (const file of after) {
    if (!before.has(file) && !allowed(file)) {
      changed.push(file);
    }
  }
  return changed.sort();
}

/**
 * The edited files the PM's own chat named while a helper ran: the PM works in the same checkout, so what it wrote then is its own,
 * not the helper's (magicseo replay 2026-10-31: the planner failed `repo_edited` on recon samples the PM had put in `.agents/recon/`
 * during the plan, 18 minutes lost). A file counts as named when the chat's text has its path or its folder (deeper than the root).
 */
export function namedByChat(texts: readonly string[], files: readonly string[]): Set<string> {
  const all = texts.join("\n");
  return new Set(files.filter((file) => {
    if (all.includes(file)) return true;
    const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return folder.includes("/") && all.includes(folder);
  }));
}

/**
 * Files Lane Pilot's own graph actions wrote into a checkout (`fs.write`), by checkout and time. Another run's read-only helper in the
 * same checkout must not be blamed for them (hub 2026-11-09: two parallel «Штурм идеи» runs failed `repo_edited` on the guidance file
 * a third run had just saved). Kept in memory for an hour: a helper's window is shorter, and a reload loses only that hour.
 */
const ENGINE_WRITES_TTL_MS = 60 * 60_000;
const engineWrites = new Map<string, Map<string, number>>();

const checkoutKey = (path: string) => path.replace(/\/+$/, "");

export function noteEngineWrite(checkoutPath: string, file: string, at = Date.now()): void {
  const key = checkoutKey(checkoutPath), files = engineWrites.get(key) ?? new Map<string, number>();
  for (const [name, when] of files) if (at - when > ENGINE_WRITES_TTL_MS) files.delete(name);
  files.set(file.replace(/^\.?\/+/, ""), at);
  engineWrites.set(key, files);
}

export function writtenByEngineSince(checkoutPath: string, since: number): Set<string> {
  return new Set([...(engineWrites.get(checkoutKey(checkoutPath)) ?? new Map<string, number>())].filter(([, when]) => when >= since).map(([name]) => name));
}

/**
 * Pure stall detection rules and subagent claimed-file verification.
 */
// @ts-expect-error TS5097
import { EDIT_TOOLS } from "./streams.ts";

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const VOLATILE = /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b|\b\d+(\.\d+)?\s?(ms|s)\b|\/tmp\/[\w.-]+|\b[0-9a-f]{12,}\b/g;
const CLASS_SWEEP = "Name the class of this failure, then sweep every similar place offline in one pass (read/grep, no reruns), fix the whole class, and run once to confirm.";

export function stallFingerprint(tool: string, toolInput: unknown, response: unknown): string {
  const body = JSON.stringify({ tool: tool.toLowerCase(), input: toolInput }) + stallResultText(response).slice(-2000).replace(VOLATILE, "#");
  let hash = 0;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash, 31) + body.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stallResultText(response: unknown): string {
  if (typeof response === "string") return response;
  try { return JSON.stringify(response) ?? ""; } // JSON.stringify(undefined) returns undefined, not a throw.
  catch { return String(response); }
}

export function stallFailed(response: unknown): boolean {
  if (response && typeof response === "object") {
    const row = response as Record<string, unknown>;
    if (row.is_error || row.error) return true;
    const code = row.exit_code ?? row.exitCode ?? row.returncode;
    if (typeof code === "number" && code !== 0) return true;
    if (row.interrupted === true) return true;
  }
  const text = stallResultText(response).slice(-2000).toLowerCase();
  return /\b(error|failed|traceback|exit code [1-9])\b/.test(text) && !/\b0 failed\b/.test(text);
}

/** Four stall rules. Advice only: the same failing call twice, then the third identical read, edit or other result. */
export function stallHint(tool: string, n: number, isFailed: boolean): string {
  const name = tool.toLowerCase();
  if (isFailed && n === 2 && !EDIT_TOOLS.has(name)) {
    return `[lane-stall class] the same failing call twice (${tool}). Do not run it a third time: change the angle. ${CLASS_SWEEP}`;
  }
  if (n < 3) return "";
  if (READ_TOOLS.has(name)) {
    return `[lane-stall] Identical ${tool} result has already been returned ${n} times. Reuse the earlier result and take the next task step; if you cannot proceed, report the concrete blocker instead of reading it again.`;
  }
  if (EDIT_TOOLS.has(name)) {
    return `[lane-stall] ${tool} on the same path with the same result ${n} times. Existing files need a targeted edit (old_string/new_string), never a whole-file rewrite.`;
  }
  return `[lane-stall] Same ${tool} result ${n} times. Change the hypothesis before retrying. ${CLASS_SWEEP}`;
}

/** The per-session stall record: fingerprint counts, the last calls' trail, the read-only run, and the patterns already nudged. */
export type StallState = {
  counts: Record<string, number>;
  /** Last 8 fingerprints, for the ping-pong rule (A B A B). */
  recent: string[];
  /** Read/Grep/Glob calls in a row with no Edit/Write/Bash between (the monologue rule). */
  readRun: number;
  /** «rule:fingerprint» keys that already nudged this session: one nudge per pattern (SMA k_hst_nudge). */
  nudged: string[];
};

/** A stall.json written before the trail existed is a bare counts map; it upgrades in place. */
export function stallStateOf(raw: unknown): StallState {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    if (row.counts && typeof row.counts === "object") {
      return {
        counts: { ...(row.counts as Record<string, number>) },
        recent: Array.isArray(row.recent) ? row.recent.map(String).slice(-8) : [],
        readRun: typeof row.readRun === "number" ? row.readRun : 0,
        nudged: Array.isArray(row.nudged) ? row.nudged.map(String).slice(-60) : [],
      };
    }
    return { counts: { ...(row as Record<string, number>) }, recent: [], readRun: 0, nudged: [] };
  }
  return { counts: {}, recent: [], readRun: 0, nudged: [] };
}

/**
 * Four stuck rules on the plain call record, no model (SMA k_hst_detect): the same failing call twice, the same
 * result three times, the last six calls alternating between two fingerprints, eight read-only calls in a row.
 * Each pattern speaks once per session (SMA k_hst_nudge): a second hit of the same rule and fingerprint stays silent.
 */
export function stallObserve(state: Record<string, number> | StallState, tool: string, toolInput: unknown, response: unknown): { state: StallState; counts: Record<string, number>; hint: string; fingerprint: string } {
  const current = stallStateOf(state);
  const fingerprint = stallFingerprint(tool, toolInput, response);
  const name = tool.toLowerCase();
  current.counts[fingerprint] = (current.counts[fingerprint] ?? 0) + 1;
  const keys = Object.keys(current.counts);
  if (keys.length > 300) current.counts = Object.fromEntries(keys.slice(-300).map((key) => [key, current.counts[key]!]));
  current.recent = [...current.recent, fingerprint].slice(-8);
  current.readRun = READ_TOOLS.has(name) ? current.readRun + 1 : 0;

  // rule + fingerprint: a nudge repeats only for a different pattern or a different call.
  const say = (rule: string, text: string): string => {
    const key = `${rule}:${fingerprint}`;
    if (current.nudged.includes(key)) return "";
    current.nudged = [...current.nudged, key].slice(-60);
    return text;
  };
  const last6 = current.recent.slice(-6);
  const pingPong = last6.length === 6 && last6[0] === last6[2] && last6[2] === last6[4] && last6[1] === last6[3] && last6[3] === last6[5] && last6[0] !== last6[1];
  let hint = "";
  if (pingPong) hint = say("pingpong", "[lane-stall] you are alternating between two calls; stop and decide which result you trust");
  if (!hint && current.readRun >= 8) hint = say("monologue", "[lane-stall] eight read-only calls in a row and nothing written: write down what you know and take the next step");
  if (!hint) {
    const repeated = stallHint(tool, current.counts[fingerprint] ?? 1, stallFailed(response));
    if (repeated) hint = say("stall", repeated);
  }
  return { state: current, counts: current.counts, fingerprint, hint };
}

export function turnOutside(files: string[], claims: string[]): string[] {
  if (!claims.length) return [];
  return files.filter((file) => !claims.some((claim) => file === claim || file.endsWith(`/${claim}`) || claim.endsWith(`/${file}`) || file.includes(claim)));
}

/**
 * A path a subagent may be said to have written: it has a folder part, no «..», and does not start with «/» or «~». A bare file
 * name counts only when `rootHas` says a file of that exact name sits at the repo root (`console.log`, `res.json` and `Next.js` are not paths).
 */
export function claimablePath(token: string, rootHas?: (name: string) => boolean): boolean {
  if (!token || token.includes("..") || token.startsWith("/") || token.startsWith("~")) return false;
  return token.includes("/") ? true : Boolean(rootHas?.(token));
}

/** Repo paths a subagent's last message names, 10 at most (SMA k_hsv_tree). */
export function claimedPaths(text: string, limit = 10, rootHas?: (name: string) => boolean): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/[\w@.-]+\/?[\w@./-]*\.[a-zA-Z0-9]{2,8}\b/g)) {
    const at = match.index ?? 0;
    // «/etc/x.txt» and «~/x.txt» lose their first character to the pattern; a link's host and path are no repo path.
    if (/[\/~]$/.test(text.slice(Math.max(0, at - 1), at)) || /:\/\/$/.test(text.slice(Math.max(0, at - 3), at))) continue;
    if (match[0].includes("..")) continue;
    const token = match[0].replace(/^[./]+/, "");
    if (!claimablePath(token, rootHas)) continue;
    found.add(token);
    if (found.size >= limit) break;
  }
  return [...found];
}

export type ClaimedState = "committed" | "dirty" | "untouched" | "phantom" | "unchecked";

/**
 * The tree's verdict on a claimed path (SMA k_hsv_tree): committed after the spawn, dirty now, present and
 * clean (untouched), or nowhere — not on disk, not in status, not in a commit — a phantom.
 */
export function claimedState(probe: { exists: boolean; dirty: boolean; committed: boolean }): ClaimedState {
  if (!probe.exists && !probe.dirty && !probe.committed) return "phantom";
  if (probe.committed) return "committed";
  if (probe.dirty) return "dirty";
  return "untouched";
}

/** The receipt line of a tree check: phantoms first, then the files the subagent never touched. */
export function treeVerifyText(states: ReadonlyArray<{ path: string; state: ClaimedState }>): string | null {
  const phantoms = states.filter((row) => row.state === "phantom").map((row) => row.path);
  const untouched = states.filter((row) => row.state === "untouched").map((row) => row.path);
  const unchecked = states.filter((row) => row.state === "unchecked").map((row) => row.path);
  if (!phantoms.length && !untouched.length && !unchecked.length) return null;
  const parts = [
    phantoms.length ? `phantoms (named but nowhere in the tree): ${phantoms.slice(0, 6).join(", ")}` : "",
    untouched.length ? `already in the tree, unchanged since before the spawn: ${untouched.slice(0, 6).join(", ")}` : "",
    unchecked.length ? `not checked in time: ${unchecked.slice(0, 6).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `[subagent-verify] ${parts}: check before you rely on the report.`;
}

export function subagentVerify(input: { claimed: string[]; changed: string[]; exists: (path: string) => boolean }): { missing: string[]; receipt: { claimed: string[]; missing: string[] } } {
  const changed = new Set(input.changed);
  const missing = input.claimed.filter((path) => !changed.has(path) && !input.exists(path)).sort();
  return {
    missing,
    receipt: { claimed: input.claimed.slice(0, 40), missing: missing.slice(0, 20) },
  };
}

export function subagentVerifyText(missing: string[]): string | null {
  if (!missing.length) return null;
  return `[subagent-verify] the subagent says it wrote ${missing.slice(0, 6).join(", ")}, but the tree does not have them: check before you rely on it.`;
}

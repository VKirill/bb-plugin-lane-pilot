// The change point of a map node: when its proof anchor (symbol-level where the anchor is a declared unit, else the
// file) last changed, mapped to the first plugin version that shipped that commit and the time that version was
// deployed. A node's change point is the latest of its own and its direct control predecessors' (one hop). The hub
// has no git and no sources, so scripts/sma-provenance.ts writes provenance.json at authoring time (`--check` says
// when it is stale); in a source checkout an anchor whose text no longer matches the recorded hash is `stale`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PROVENANCE from "./provenance.json";
import { CONTROL_LINKS } from "./reach";
import type { SiblingName } from "./siblings";
import { anchorName, matchClose, resolveSpan, symbolSpan, workflowNodeSpan } from "./symbols";

/** [commit (12), commit time ms, first version that shipped it or null, its deploy time ms or null, symbol|file, anchor hash (12)]. */
export type OwnChange = readonly [commit: string, committedAt: number, version: string | null, deployedAt: number | null, level: "symbol" | "file", anchorHash: string];
/** A node whose proof anchor lives in a sibling repository (siblings.ts): [sibling, commit (12), commit time ms, symbol|text|file, anchor hash (12)],
 * read at the pinned commit `siblingsAt[sibling]`. No deploy is known for it: see `traceAfter`. */
export type SiblingChange = readonly [sibling: SiblingName, commit: string, committedAt: number, level: "symbol" | "text" | "file", anchorHash: string];
export type ProvenanceFile = { generatedFrom: string; version: string; deploys: number; lastDeployed?: string; nodes: Readonly<Record<string, OwnChange>>; siblingsAt?: Readonly<Partial<Record<SiblingName, string>>>; siblings?: Readonly<Record<string, SiblingChange>> };
export const SMA_PROVENANCE = PROVENANCE as unknown as ProvenanceFile;

/** The first time the hub ran each plugin version, from the earliest of every record that stamps the running version with a time,
 * so a fresh deploy is dated without waiting for a task: an attempt (lane_pilot_attempt.harness_version), a workflow run, which the
 * upkeep graphs start all day (lane_pilot_wf_run.harness_version), and a memory probe (lane_pilot_memory_probe.lp_version).
 * A version none of them has seen is absent, and an absent version never makes a trace count (traceAfter).
 * A change made after provenance.json was generated ships in the first version newer than the file's `lastDeployed`. */
export type VersionSeen = ReadonlyMap<string, number>;
type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
// Read-only looks into the storage room's tables, composed like every other sma-map query (live.ts, traces.ts).
const P = "lane_pilot_";
const VERSION_SOURCES: ReadonlyArray<readonly [table: string, version: string, at: string]> = [["attempt", "harness_version", "created_at"], ["wf_run", "harness_version", "created_at"], ["memory_probe", "lp_version", "at"]];
export function versionSeen(db: Db): VersionSeen {
  const seen = new Map<string, number>();
  for (const [table, version, at] of VERSION_SOURCES) {
    let rows: Array<{ version: string; at: number }>;
    try { rows = db.prepare(`SELECT ${version} AS version, MIN(${at}) AS at FROM ${P}${table} WHERE ${version} GLOB '[0-9]*.[0-9]*.[0-9]*' GROUP BY ${version}`).all() as typeof rows; } catch { continue; }
    for (const row of rows) { const time = Number(row.at); if (Number.isFinite(time) && time < (seen.get(row.version) ?? Infinity)) seen.set(row.version, time); }
  }
  return seen;
}
const semver = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
/** The first version newer than `after` the hub ran, with its first-seen time. */
export function firstSeenAfter(seen: VersionSeen, after: string): { version: string; at: number } | null {
  let best: { version: string; at: number } | null = null;
  for (const [version, at] of seen) if (newerVersion(version, after) && (!best || at < best.at)) best = { version, at };
  return best;
}

/** `sibling`: the anchor lives in a sibling repository; its last change is known (commit and time), the hub version that
 * shipped it is not (the hub records no core build or plugin install times: docs/sma-evidence.md «Proofs in a sibling repository»). */
export type ChangePoint =
  | { state: "shipped"; version: string; deployedAt: number; commit: string; from: string }
  | { state: "unshipped"; commit: string; from: string }
  | { state: "stale"; from: string }
  | { state: "sibling"; sibling: SiblingName; commit: string; committedAt: number; from: string }
  | { state: "unknown" };

/** The text a node's change point is hashed over: the anchor's span (symbol level) or the whole file. */
export function anchorText(root: string, proof: string): { text: string; level: "symbol" | "file"; file: string; start?: number; end?: number } | null {
  const [file, symbol] = proof.split("#", 2) as [string, string | undefined];
  let whole: string;
  try { whole = readFileSync(join(root, file), "utf8"); } catch { return null; }
  if (symbol && /\.[cm]?[jt]sx?$/.test(file)) {
    const name = anchorName(symbol);
    const span = name ? resolveSpan(root, file, name) : null;
    if (span) return { text: span.text, level: "symbol", file: span.file, start: span.start, end: span.end };
  }
  if (symbol && file.endsWith(".json")) {
    const node = /^"(?:id": ")?([\w.-]+)"$/.exec(symbol)?.[1];
    const span = node && node !== "entry" ? workflowNodeSpan(whole, node) : null;
    if (span) return { text: span.text, level: "symbol", file, start: span.start, end: span.end };
  }
  return { text: whole, level: "file", file };
}

export const hash12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** A local proof (this repository) — the only kind the plugin's version timeline can date. */
export const localProof = (proof: string | undefined): proof is string => !!proof && !/^(lane-stack|core|telegram):/.test(proof);

type Link = readonly [from: string, to: string, kind: string, label: string];

/** Change points for every node: own change, else predecessors'; `root` (a source checkout) enables the stale check. */
export function changePoints(ids: readonly string[], links: readonly Link[], proofOf: (id: string) => string | undefined, root: string, file: ProvenanceFile = SMA_PROVENANCE, seen?: VersionSeen): Map<string, ChangePoint> {
  const own = new Map<string, ChangePoint>();
  // Unshipped when the file was generated: shipped in the first version after the last deploy, if the hub ran one.
  const next = seen && file.lastDeployed ? firstSeenAfter(seen, file.lastDeployed) : null;
  for (const id of ids) {
    const rec = file.nodes[id];
    const proof = proofOf(id);
    const sib = file.siblings?.[id];
    if (!rec && sib) { own.set(id, { state: "sibling", sibling: sib[0], commit: sib[1], committedAt: sib[2], from: id }); continue; }
    if (!rec) { own.set(id, { state: "unknown" }); continue; }
    if (root && localProof(proof)) {
      const now = anchorText(root, proof);
      if (now && hash12(now.text) !== rec[5]) { own.set(id, { state: "stale", from: id }); continue; }
    }
    own.set(id, rec[2] && rec[3] ? { state: "shipped", version: rec[2], deployedAt: rec[3], commit: rec[0], from: id }
      : next ? { state: "shipped", version: next.version, deployedAt: next.at, commit: rec[0], from: id }
      : { state: "unshipped", commit: rec[0], from: id });
  }
  const preds = new Map<string, string[]>();
  for (const [from, to, kind] of links) if (CONTROL_LINKS.has(kind)) preds.set(to, [...(preds.get(to) ?? []), from]);
  const rank = (point: ChangePoint) => (point.state === "shipped" ? point.deployedAt : point.state === "sibling" ? point.committedAt : point.state === "unknown" ? -1 : Infinity);
  const out = new Map<string, ChangePoint>();
  for (const id of ids) {
    let best = own.get(id)!;
    for (const pred of preds.get(id) ?? []) {
      const point = own.get(pred);
      if (point && point.state !== "unknown" && rank(point) > rank(best)) best = point;
    }
    out.set(id, best);
  }
  return out;
}

/** Whether a trace at `last` (ms) is newer than the change point: on a version that has the node's last change. An
 * unknown change point (no local proof, no record) does not hold a trace back; unshipped and stale do. A sibling change
 * point holds back every trace older than the change's commit (no build can have had it then); a newer one counts, and
 * `--states` lists the node as closed with an unknown sibling change point (the hub cannot say since when it runs it). */
export function traceAfter(point: ChangePoint, last: number | null): boolean {
  if (last === null) return false;
  if (point.state === "unknown") return true;
  if (point.state === "sibling") return last >= point.committedAt;
  return point.state === "shipped" && last >= point.deployedAt;
}

/** The span a sibling proof's anchor names in `text` (the file at the pinned commit): a declared unit, else the line the
 * anchor text is on (through the block it opens, when it opens one), else the whole file. Lines are 1-based. */
export function siblingAnchorSpan(text: string, symbol: string | undefined): { level: "symbol" | "text" | "file"; start: number; end: number; text: string } {
  const lines = text.split("\n");
  const whole = { level: "file" as const, start: 1, end: lines.length, text };
  if (!symbol) return whole;
  const name = anchorName(symbol);
  const span = name ? symbolSpan(text, name) : null;
  if (span) return { level: "symbol", start: span.start, end: span.end, text: span.text };
  const at = text.indexOf(symbol);
  if (at < 0) return whole;
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const lineEnd = text.indexOf("\n", at) < 0 ? text.length : text.indexOf("\n", at);
  const open = text.slice(at, lineEnd).trimEnd().endsWith("{") ? text.lastIndexOf("{", lineEnd) : -1;
  const end = open >= at ? matchClose(text, open) + 1 : lineEnd;
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  return { level: "text", start: lineOf(lineStart), end: lineOf(Math.max(lineStart, end - 1)), text: text.slice(lineStart, end) };
}

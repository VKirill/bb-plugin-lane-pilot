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
import { anchorName, resolveSpan, workflowNodeSpan } from "./symbols";

/** [commit (12), commit time ms, first version that shipped it or null, its deploy time ms or null, symbol|file, anchor hash (12)]. */
export type OwnChange = readonly [commit: string, committedAt: number, version: string | null, deployedAt: number | null, level: "symbol" | "file", anchorHash: string];
export type ProvenanceFile = { generatedFrom: string; version: string; deploys: number; lastDeployed?: string; nodes: Readonly<Record<string, OwnChange>> };
export const SMA_PROVENANCE = PROVENANCE as unknown as ProvenanceFile;

/** The first time the hub ran each plugin version: every attempt row stamps the version that started it
 * (lane_pilot_attempt.harness_version). A change made after provenance.json was generated ships in the first version
 * newer than the file's `lastDeployed`; on the hub this dates it without git or the deploy log. */
export type VersionSeen = ReadonlyMap<string, number>;
type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
export function versionSeen(db: Db): VersionSeen {
  const rows = db.prepare("SELECT harness_version AS version, MIN(created_at) AS at FROM lane_pilot_attempt WHERE harness_version GLOB '[0-9]*.[0-9]*.[0-9]*' GROUP BY harness_version").all() as Array<{ version: string; at: number }>;
  return new Map(rows.map((row) => [row.version, Number(row.at)] as const));
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

export type ChangePoint =
  | { state: "shipped"; version: string; deployedAt: number; commit: string; from: string }
  | { state: "unshipped"; commit: string; from: string }
  | { state: "stale"; from: string }
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
  const rank = (point: ChangePoint) => (point.state === "shipped" ? point.deployedAt : point.state === "unknown" ? -1 : Infinity);
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
 * unknown change point (no local proof, no record) does not hold a trace back; unshipped and stale do. */
export function traceAfter(point: ChangePoint, last: number | null): boolean {
  if (last === null) return false;
  if (point.state === "unknown") return true;
  return point.state === "shipped" && last >= point.deployedAt;
}

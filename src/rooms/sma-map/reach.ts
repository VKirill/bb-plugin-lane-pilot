// Reachability of map nodes (sma-parity-tz.md §4.3): a node is reachable iff its own `needs` hold under the effective
// settings AND (it declares an `entry` — a class of normal input event — OR one of its control predecessors is
// reachable). Control links: transition, calls, retries and guards (the gate lets work through to what it guards).
// Passive nodes (store, document, screen) are reachable when a reachable node writes, reads or shows them.
// The static cross-check `undeclaredGates` keeps self-declared reach honest: a switch-like setting the node's own
// function reads, whose default turns it off, and that `needs` does not declare.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NeedValue, ReachSpec } from "./evidence/types";
import { settingRegistry, settingWord, type EffectiveSettings } from "./settings-registry";
import { anchorName, resolveSpan, stringLiterals } from "./symbols";

export const CONTROL_LINKS: ReadonlySet<string> = new Set(["transition", "calls", "retries", "guards"]);
export const PASSIVE_LINKS: ReadonlySet<string> = new Set(["writes", "reads", "shows"]);
export const PASSIVE_KINDS: ReadonlySet<string> = new Set(["store", "document", "screen"]);

type Node = readonly [id: string, region: number, group: string, kind: string, label: string];
type Link = readonly [from: string, to: string, kind: string, label: string];

/** Whether the effective value of a setting satisfies a need (words compared after on/off folding; unset is no word). */
export function needHolds(need: NeedValue, value: string | undefined): boolean {
  const words = (w: string | readonly string[]) => (typeof w === "string" ? [w] : [...w]).map((word) => settingWord(word) ?? word);
  if (typeof need === "object" && !Array.isArray(need) && "set" in need) return value !== undefined && value !== "";
  if (typeof need === "object" && !Array.isArray(need) && "not" in need) return value === undefined || !words((need as { not: string | readonly string[] }).not).includes(value);
  return value !== undefined && words(need as string | readonly string[]).includes(value);
}

/** The needs of a spec that fail under `settings`, as `key=value (needs …)` lines. */
export function failedNeeds(spec: ReachSpec | undefined, settings: EffectiveSettings): string[] {
  return Object.entries(spec?.needs ?? {}).filter(([key, need]) => !needHolds(need, settings.get(key)))
    .map(([key, need]) => `${key}=${settings.get(key) ?? "unset"} (needs ${typeof need === "string" ? need : JSON.stringify(need)})`);
}

export type ReachResult = { reachable: boolean; why: string };

/** Propagates reachability over the graph; `reachOf` gives a node's declared reach. */
export function evaluateReach(nodes: readonly Node[], links: readonly Link[], reachOf: (id: string) => ReachSpec | undefined, settings: EffectiveSettings): Map<string, ReachResult> {
  const kind = new Map(nodes.map(([id, , , k]) => [id, k] as const));
  const out = new Map<string, ReachResult>();
  const open = (id: string) => failedNeeds(reachOf(id), settings).length === 0;
  const succ = new Map<string, string[]>();
  const neighbours = new Map<string, string[]>();
  for (const [from, to, linkKind] of links) {
    if (CONTROL_LINKS.has(linkKind)) succ.set(from, [...(succ.get(from) ?? []), to]);
    if (PASSIVE_LINKS.has(linkKind)) { neighbours.set(from, [...(neighbours.get(from) ?? []), to]); neighbours.set(to, [...(neighbours.get(to) ?? []), from]); }
  }
  const queue: string[] = [];
  const mark = (id: string, why: string) => { if (!out.has(id) && open(id)) { out.set(id, { reachable: true, why }); queue.push(id); } };
  for (const [id] of nodes) { const spec = reachOf(id); if (spec?.entry) mark(id, `entry: ${spec.entry}`); }
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of succ.get(id) ?? []) mark(to, `from ${id}`);
    if (!PASSIVE_KINDS.has(kind.get(id) ?? "")) for (const other of neighbours.get(id) ?? []) if (PASSIVE_KINDS.has(kind.get(other) ?? "")) mark(other, `touched by ${id}`);
  }
  for (const [id] of nodes) {
    if (out.has(id)) continue;
    const failed = failedNeeds(reachOf(id), settings);
    const preds = links.filter(([, to, linkKind]) => to === id && CONTROL_LINKS.has(linkKind)).map(([from]) => from);
    out.set(id, { reachable: false, why: failed.length ? `needs fail: ${failed.join("; ")}` : preds.length ? `no reachable predecessor (${preds.slice(0, 4).join(", ")}${preds.length > 4 ? ", …" : ""})` : PASSIVE_KINDS.has(kind.get(id) ?? "") ? "no reachable node writes, reads or shows it" : "no entry and no control predecessor" });
  }
  return out;
}

/** The setting keys a proof's function names as literals, or null when the proof is not a function in this checkout. */
export function settingReads(root: string, proof: string | undefined): string[] | null {
  if (!root || !proof || /^(lane-stack|core|telegram):/.test(proof)) return null;
  const [file, symbol] = proof.split("#", 2) as [string, string | undefined];
  if (!symbol || !/\.[cm]?[jt]sx?$/.test(file)) return null;
  const name = anchorName(symbol);
  let span;
  try { span = name ? resolveSpan(root, file, name) : null; } catch { return null; }
  if (!span) return null;
  const registry = settingRegistry();
  return [...new Set(stringLiterals(span.text).filter((key) => registry.has(key)))].sort();
}

/** Switch-like settings a node's function reads whose effective value is off, that its `needs` does not declare and
 * `notGatedBy` does not dismiss: an `undeclared gate` (hollow sign 4 on a node the map calls working). */
export function undeclaredGates(reads: readonly string[] | null, spec: ReachSpec | undefined, settings: EffectiveSettings): string[] {
  if (!reads) return [];
  const registry = settingRegistry();
  // Only a known «off»: an unset switch whose default the registry does not know may well run the branch
  // (calibration 2026-11-14: writer.fast_mode).
  const off = (key: string) => settings.get(key) === "off";
  return reads.filter((key) => registry.get(key)?.switchLike && off(key))
    .filter((key) => !(spec?.needs && key in spec.needs) && !(spec?.notGatedBy && key in spec.notGatedBy));
}

/** The text of a file under `root`, or null. */
export const readSource = (root: string, file: string): string | null => { try { return readFileSync(join(root, file), "utf8"); } catch { return null; } };

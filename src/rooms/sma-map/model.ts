import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { declaredNames, relocateAnchor } from "./exports";
import { SMA_CONTRACT_TESTS } from "./contracts";
import { SMA_AUDIT_GAPS, SMA_CONTRACT_GAPS } from "./gaps";
import { SMA_ENTRIES, type SmaStatus } from "./entries";
import { SMA_CARDS, SMA_NODES, SMA_REGIONS, type SmaKind } from "./graph";

/** One node of the SMA map with what we have for it: the card's own words, our counterpart, its proof link and the contract tests. */
export type SmaRow = { id: string; smaId: string; region: string; group: string; kind: SmaKind; label: string; detail: string; unsure: boolean;
  status: SmaStatus; ours: string; proof?: string; contracts: readonly string[]; gaps: readonly string[] };
/** proven: a proof link (navigation); contract: a test checks the card's behaviour; upstream: SMA itself left the node unwired; void: nothing here for the card to guard. */
export type SmaCounts = { total: number; have: number; partial: number; missing: number; skip: number; upstream: number; void: number; deviation: number; "deviation-data": number; proven: number; contract: number };

/** Repositories a proof can point into: this one, Lane Stack and the BB core with its vk layer. */
export type ProofRoots = { lanePilot: string; laneStack?: string; core?: string; telegram?: string };

export function smaRows(): SmaRow[] {
  return SMA_NODES.map(([id, region, group, kind, label]) => {
    const entry = SMA_ENTRIES[id];
    const card = SMA_CARDS[id];
    const gaps = [...(SMA_CONTRACT_GAPS[card?.[0] ?? id] ?? []), ...(SMA_AUDIT_GAPS[card?.[0] ?? id] ?? [])];
    // A behaviour test that found the card's behaviour missing (it.todo) outranks the claim of the map (2026-10-29 SMA zone tests).
    const status: SmaStatus = gaps.length && entry?.[0] === "have" ? "partial" : entry?.[0] ?? "missing";
    return { id, smaId: card?.[0] ?? id, region: SMA_REGIONS[region] ?? String(region), group, kind, label, detail: card?.[1] ?? "", unsure: card?.[3] ?? false,
      status, ours: entry?.[1] ?? "", ...(entry?.[2] ? { proof: entry[2] } : {}), contracts: SMA_CONTRACT_TESTS[card?.[0] ?? id] ?? [], gaps };
  });
}

/**
 * Mapped: we have it and a proof points at the code, or SMA itself left it unwired and we hold the same state. A proof link is not
 * a check of behaviour (2026-10-29 conformance audit: the «100%» counted links): conformance is `isChecked`, a contract test.
 */
export const isDone = (row: SmaRow) => (row.status === "have" && !!row.proof) || row.status === "upstream" || row.status === "void" || row.status === "deviation" || row.status === "deviation-data";
/** Checked: a contract test (`[sma:<id>]` in its title, contracts.ts) holds our code to the card's behaviour. */
export const isChecked = (row: SmaRow) => row.contracts.length > 0;

export function smaCounts(rows: readonly SmaRow[]): SmaCounts {
  const counts: SmaCounts = { total: rows.length, have: 0, partial: 0, missing: 0, skip: 0, upstream: 0, void: 0, deviation: 0, "deviation-data": 0, proven: 0, contract: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status === "have" && row.proof) counts.proven += 1;
    if (isChecked(row)) counts.contract += 1;
  }
  return counts;
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
/** Share of the map that is mapped (a proof link, or unwired in SMA too), in percent with one decimal. */
export const smaDonePercent = (rows: readonly SmaRow[]) => percent(rows.filter(isDone).length, rows.length);
/** Share of the map a contract test checks: the measure of conformance. */
export const smaCheckedPercent = (rows: readonly SmaRow[]) => percent(rows.filter(isChecked).length, rows.length);

/**
 * The proof-link ladder of one node (roast X-2), kept as the weaker signal beside the four proofs of sma-parity-tz.md §4
 * (states.ts: checked, mutated, reachable, outcome-verified):
 * - `available`: we declare a counterpart (have or partial).
 * - `proofResolved`: its proof link resolves on this machine (a proof into an absent sibling repo is unjudged: null).
 *   It was called `reachable` until 2026-11-14; reachability is now TZ 4.3 (reach.ts), not «the link resolves».
 * - `checked`: a contract test holds the code to the card's behaviour.
 * - `outcome`: checked AND the node's GROUP left a live trace (`groupObserved`) — not node-level evidence.
 */
export type SmaEvidence = { available: boolean; proofResolved: boolean | null; checked: boolean; outcome: "verified" | "unverified" | "unknown" };

export function smaEvidence(row: SmaRow, roots: ProofRoots, groupObserved?: boolean): SmaEvidence {
  const available = row.status === "have" || row.status === "partial";
  const proofResolved = !row.proof ? null : unjudgedProof(row.proof, roots) ? null : brokenProof(row.proof, roots) === null;
  const checked = isChecked(row);
  const outcome = groupObserved === undefined ? "unknown" : groupObserved && checked ? "verified" : "unverified";
  return { available, proofResolved, checked, outcome };
}

/** The proof-link tally over the map. `groupObserved`/`groupOutcomeVerified` fill only when live group rows were read. */
export type SmaStateCounts = { total: number; available: number; proofResolved: number; proofBroken: number; proofUnjudged: number; checked: number; groupObserved: number | null; groupOutcomeVerified: number | null };

export function smaStateCounts(rows: readonly SmaRow[], roots: ProofRoots, groupObservedOf?: (row: SmaRow) => boolean | undefined): SmaStateCounts {
  const out: SmaStateCounts = { total: rows.length, available: 0, proofResolved: 0, proofBroken: 0, proofUnjudged: 0, checked: 0, groupObserved: groupObservedOf ? 0 : null, groupOutcomeVerified: groupObservedOf ? 0 : null };
  for (const row of rows) {
    const observed = groupObservedOf?.(row);
    const evidence = smaEvidence(row, roots, observed);
    if (evidence.available) out.available++;
    if (evidence.proofResolved === true) out.proofResolved++;
    else if (evidence.proofResolved === false) out.proofBroken++;
    else if (row.proof) out.proofUnjudged++;
    if (evidence.checked) out.checked++;
    if (observed === true) out.groupObserved!++;
    if (evidence.outcome === "verified") out.groupOutcomeVerified!++;
  }
  return out;
}

/** Registry holes: map nodes without an entry, entries for nodes the map does not have, and any node left out (skip). */
export function smaHoles(): string[] {
  const ids = new Set(SMA_NODES.map(([id]) => id));
  const holes: string[] = [];
  for (const id of ids) if (!SMA_ENTRIES[id]) holes.push(`${id}: no entry`);
  for (const id of Object.keys(SMA_ENTRIES)) if (!ids.has(id)) holes.push(`${id}: entry for a node the map does not have`);
  for (const [id, entry] of Object.entries(SMA_ENTRIES)) if (entry[0] === "skip") holes.push(`${id}: left out — the whole map is built`);
  return holes;
}

/**
 * A proof into a repository whose sources this machine does not have: not judged, and counted as such (never as resolved).
 * That includes this plugin's own sources: the hub runs the built plugin, and `--check-proofs` there called all 1509 local
 * proofs broken with «no such file» (2026-11-10). An empty `lanePilot` root says the sources are absent.
 */
export function unjudgedProof(proof: string, roots: ProofRoots): boolean {
  const prefix = proof.match(/^(lane-stack|core|telegram):/);
  if (!prefix) return !roots.lanePilot;
  return !(prefix[1] === "lane-stack" ? roots.laneStack : prefix[1] === "telegram" ? roots.telegram : roots.core);
}

/** Extensions whose file is a module: a `#anchor` must name a declared unit in the file — a function, const, class,
 * method, property key or case label at any depth — never body text. Exported or not: the anchor names what implements
 * the claim, and renaming that unit must break the proof. */
const MODULE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** `export function foo(`, `export const FOO`, `function foo(`, `const FOO` → the declared name. */
const DECLARED = /(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const IDENTIFIERISH = /^[A-Za-z_$][\w$]*$/;
const declCache = new Map<string, Set<string>>();

/** The declared unit an anchor names, or null when the file declares no such name. */
function declaredAnchor(file: string, text: string, symbol: string): string | null {
  const name = DECLARED.exec(symbol)?.slice(1).find(Boolean) ?? (IDENTIFIERISH.test(symbol) ? symbol : null);
  if (!name) return null;
  let names = declCache.get(file);
  if (!names) { names = declaredNames(text, file.endsWith("x")); declCache.set(file, names); }
  return names.has(name) ? name : null;
}

/** A proof that does not resolve: the file is missing, or the anchor is not what it claims. Strict — a moved anchor
 * is a broken proof (see proofDrift for where it went and `sma-map --fix-proofs` to repair the path). In a module the
 * anchor must name a declared unit — checked against the file's declarations at any depth, so body text cannot pose
 * as proof but a private handler can. Data files (json, sh, py, md, …) have no declarations; there the anchor is a
 * literal the file must carry. Proofs into an absent sibling repository are not judged. */
export function brokenProof(proof: string, roots: ProofRoots): string | null {
  const [where, symbol] = proof.split("#", 2) as [string, string | undefined];
  const prefix = where.match(/^(lane-stack|core|telegram):(.*)$/);
  const root = prefix ? (prefix[1] === "lane-stack" ? roots.laneStack : prefix[1] === "telegram" ? roots.telegram : roots.core) : roots.lanePilot;
  const path = prefix ? prefix[2]! : where;
  if (!root) return null;
  const file = resolve(join(root, path));
  if (!existsSync(file)) return `${proof}: no such file`;
  if (!symbol) return null;
  const text = readFileSync(file, "utf8");
  if (MODULE_FILE.test(path)) {
    if (!declaredAnchor(file, text, symbol)) return `${proof}: ${symbol} is not declared in the module`;
    return null;
  }
  if (!text.includes(symbol)) return `${proof}: ${symbol} is not in the file`;
  return null;
}

/** Where a broken local proof's anchor now lives: exactly one file exporting the identifier (module surface,
 * not text) or carrying the text — or null (deleted, or ambiguous). `--fix-proofs` rewrites the entry path then. */
export function proofRelocation(proof: string, roots: ProofRoots): string | null {
  const [where, symbol] = proof.split("#", 2) as [string, string | undefined];
  if (!symbol || /^(lane-stack|core|telegram):/.test(where)) return null;
  if (!brokenProof(proof, roots)) return null;
  return relocateAnchor(roots.lanePilot, symbol);
}

/** The drift line `--check-proofs` prints for a proof whose anchor moved: name and how to repair. */
export function proofDrift(proof: string, roots: ProofRoots): string | null {
  const at = proofRelocation(proof, roots);
  return at ? `${proof}: moved to ${at} — run sma-map --fix-proofs` : null;
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SMA_CONTRACT_TESTS } from "./contracts";
import { SMA_ENTRIES, type SmaStatus } from "./entries";
import { SMA_CARDS, SMA_NODES, SMA_REGIONS, type SmaKind } from "./graph";

/** One node of the SMA map with what we have for it: the card's own words, our counterpart, its proof link and the contract tests. */
export type SmaRow = { id: string; smaId: string; region: string; group: string; kind: SmaKind; label: string; detail: string; unsure: boolean;
  status: SmaStatus; ours: string; proof?: string; contracts: readonly string[] };
/** proven: a proof link (navigation); contract: a test checks the card's behaviour; upstream: SMA itself left the node unwired. */
export type SmaCounts = { total: number; have: number; partial: number; missing: number; skip: number; upstream: number; proven: number; contract: number };

/** Repositories a proof can point into: this one, Lane Stack and the BB core with its vk layer. */
export type ProofRoots = { lanePilot: string; laneStack?: string; core?: string; telegram?: string };

export function smaRows(): SmaRow[] {
  return SMA_NODES.map(([id, region, group, kind, label]) => {
    const entry = SMA_ENTRIES[id];
    const card = SMA_CARDS[id];
    return { id, smaId: card?.[0] ?? id, region: SMA_REGIONS[region] ?? String(region), group, kind, label, detail: card?.[1] ?? "", unsure: card?.[3] ?? false,
      status: entry?.[0] ?? "missing", ours: entry?.[1] ?? "", ...(entry?.[2] ? { proof: entry[2] } : {}), contracts: SMA_CONTRACT_TESTS[card?.[0] ?? id] ?? [] };
  });
}

/**
 * Mapped: we have it and a proof points at the code, or SMA itself left it unwired and we hold the same state. A proof link is not
 * a check of behaviour (2026-10-29 conformance audit: the «100%» counted links): conformance is `isChecked`, a contract test.
 */
export const isDone = (row: SmaRow) => (row.status === "have" && !!row.proof) || row.status === "upstream";
/** Checked: a contract test (`[sma:<id>]` in its title, contracts.ts) holds our code to the card's behaviour. */
export const isChecked = (row: SmaRow) => row.contracts.length > 0;

export function smaCounts(rows: readonly SmaRow[]): SmaCounts {
  const counts: SmaCounts = { total: rows.length, have: 0, partial: 0, missing: 0, skip: 0, upstream: 0, proven: 0, contract: 0 };
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

/** Registry holes: map nodes without an entry, entries for nodes the map does not have, and any node left out (skip). */
export function smaHoles(): string[] {
  const ids = new Set(SMA_NODES.map(([id]) => id));
  const holes: string[] = [];
  for (const id of ids) if (!SMA_ENTRIES[id]) holes.push(`${id}: no entry`);
  for (const id of Object.keys(SMA_ENTRIES)) if (!ids.has(id)) holes.push(`${id}: entry for a node the map does not have`);
  for (const [id, entry] of Object.entries(SMA_ENTRIES)) if (entry[0] === "skip") holes.push(`${id}: left out — the whole map is built`);
  return holes;
}

/** A proof into a sibling repository this machine does not have: not judged, and counted as such (never as resolved). */
export function unjudgedProof(proof: string, roots: ProofRoots): boolean {
  const prefix = proof.match(/^(lane-stack|core|telegram):/);
  return !!prefix && !(prefix[1] === "lane-stack" ? roots.laneStack : prefix[1] === "telegram" ? roots.telegram : roots.core);
}

/** A proof that does not resolve: the file is missing, or the symbol is not in it. Proofs into an absent sibling repository are not judged. */
export function brokenProof(proof: string, roots: ProofRoots): string | null {
  const [where, symbol] = proof.split("#", 2) as [string, string | undefined];
  const prefix = where.match(/^(lane-stack|core|telegram):(.*)$/);
  const root = prefix ? (prefix[1] === "lane-stack" ? roots.laneStack : prefix[1] === "telegram" ? roots.telegram : roots.core) : roots.lanePilot;
  const path = prefix ? prefix[2]! : where;
  if (!root) return null;
  const file = resolve(join(root, path));
  if (!existsSync(file)) return `${proof}: no such file`;
  if (symbol && !readFileSync(file, "utf8").includes(symbol)) return `${proof}: ${symbol} is not in the file`;
  return null;
}

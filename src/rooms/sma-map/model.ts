import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SMA_ENTRIES, type SmaStatus } from "./entries";
import { SMA_NODES, SMA_REGIONS, type SmaKind } from "./graph";

/** One node of the SMA map with what we have for it. */
export type SmaRow = { id: string; region: string; group: string; kind: SmaKind; label: string; status: SmaStatus; ours: string; proof?: string };
export type SmaCounts = { total: number; have: number; partial: number; missing: number; skip: number; proven: number };

/** Repositories a proof can point into: this one, Lane Stack and the BB core with its vk layer. */
export type ProofRoots = { lanePilot: string; laneStack?: string; core?: string; telegram?: string };

export function smaRows(): SmaRow[] {
  return SMA_NODES.map(([id, region, group, kind, label]) => {
    const entry = SMA_ENTRIES[id];
    return { id, region: SMA_REGIONS[region] ?? String(region), group, kind, label, status: entry?.[0] ?? "missing", ours: entry?.[1] ?? "", ...(entry?.[2] ? { proof: entry[2] } : {}) };
  });
}

/** Done means: we have it and a proof points at the code. Nothing is left out (the owner, 2026-10-24: «нам нужна 100% реализация»). */
export const isDone = (row: SmaRow) => row.status === "have" && !!row.proof;

export function smaCounts(rows: readonly SmaRow[]): SmaCounts {
  const counts: SmaCounts = { total: rows.length, have: 0, partial: 0, missing: 0, skip: 0, proven: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status === "have" && row.proof) counts.proven += 1;
  }
  return counts;
}

/** Share of the map that is done (proven in the code), in percent with one decimal. */
export const smaDonePercent = (rows: readonly SmaRow[]) => (rows.length ? Math.round((rows.filter(isDone).length / rows.length) * 1000) / 10 : 0);

/** Registry holes: map nodes without an entry, entries for nodes the map does not have, and any node left out (skip). */
export function smaHoles(): string[] {
  const ids = new Set(SMA_NODES.map(([id]) => id));
  const holes: string[] = [];
  for (const id of ids) if (!SMA_ENTRIES[id]) holes.push(`${id}: no entry`);
  for (const id of Object.keys(SMA_ENTRIES)) if (!ids.has(id)) holes.push(`${id}: entry for a node the map does not have`);
  for (const [id, entry] of Object.entries(SMA_ENTRIES)) if (entry[0] === "skip") holes.push(`${id}: left out — the whole map is built`);
  return holes;
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

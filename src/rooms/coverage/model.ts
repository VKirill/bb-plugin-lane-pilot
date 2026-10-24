import { STAGE_IDS } from "@lane-pilot/contracts";
import { MEMORY_PATHS } from "../memory";
import { TRANSITION_TABLE } from "../runs";
import { GATE_CATEGORIES } from "../storage";
import { COVERAGE, type CoverageEntry, type NodeKind } from "./registry";

/** How a node is proven: by a drill scenario that runs it on the hub, by tests only, or not at all. */
export type CoverageStatus = "live" | "tests" | "none";
export type CoverageRow = { kind: NodeKind; id: string; status: CoverageStatus; live: readonly string[]; tests: readonly string[]; note: string };

export const transitionId = (row: { from: string | null; event: string }): string => `${row.from ?? "∅"}+${row.event}`;

/** The nodes the code itself lists: a node here without an entry is a hole. Failure classes and rooms are listed from their sources by the test. */
export function codeNodes(): Array<{ kind: NodeKind; id: string }> {
  return [
    ...STAGE_IDS.map((id) => ({ kind: "stage" as const, id })),
    ...TRANSITION_TABLE.map((row) => ({ kind: "transition" as const, id: transitionId(row) })),
    ...GATE_CATEGORIES.map((id) => ({ kind: "gate" as const, id })),
    ...MEMORY_PATHS.map((path) => ({ kind: "memory_path" as const, id: path.id })),
  ];
}

const statusOf = (entry: CoverageEntry): CoverageStatus => (entry.live?.length ? "live" : entry.tests?.length ? "tests" : "none");

/**
 * One row per node. Memory paths come from their own registry (src/rooms/memory/memory-paths.ts): a probed path is run by the drill's
 * `memory_paths` scenario, an exempt one carries the reason it cannot be probed.
 */
export function coverageRows(entries: readonly CoverageEntry[] = COVERAGE): CoverageRow[] {
  const rows: CoverageRow[] = entries.flatMap((entry) => entry.ids.map((id): CoverageRow => ({
    kind: entry.kind, id, status: statusOf(entry), live: entry.live ?? [], tests: entry.tests ?? [], note: entry.live?.length ? entry.via ?? "" : entry.reason ?? "",
  })));
  for (const path of MEMORY_PATHS) {
    rows.push(path.status === "probed"
      ? { kind: "memory_path", id: path.id, status: "live", live: ["memory_paths"], tests: ["tests/memory-paths.test.ts"], note: `the probe asks this path what its agent would receive${path.live ? `; the drill also checks the real ${path.live}` : ""}` }
      : { kind: "memory_path", id: path.id, status: "none", live: [], tests: ["tests/memory-paths.test.ts"], note: path.reason ?? "exempt from the probe" });
  }
  return rows;
}

export type CoverageSummary = Record<NodeKind | "all", { live: number; tests: number; none: number; total: number }>;

export function summarize(rows: readonly CoverageRow[]): CoverageSummary {
  const out = Object.fromEntries(["all", ...new Set(rows.map((row) => row.kind))].map((kind) => [kind, { live: 0, tests: 0, none: 0, total: 0 }])) as CoverageSummary;
  for (const row of rows) for (const key of ["all", row.kind] as const) { out[key][row.status] += 1; out[key].total += 1; }
  return out;
}

/** A node the code lists that no entry covers, and an entry's node the code no longer lists. */
export function holes(rows: readonly CoverageRow[], nodes: ReadonlyArray<{ kind: NodeKind; id: string }> = codeNodes()): { missing: string[]; stale: string[]; duplicate: string[] } {
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const have = new Map<string, number>();
  for (const row of rows) have.set(key(row.kind, row.id), (have.get(key(row.kind, row.id)) ?? 0) + 1);
  const want = new Set(nodes.map((node) => key(node.kind, node.id)));
  return {
    missing: [...want].filter((node) => !have.has(node)),
    stale: [...have.keys()].filter((node) => !want.has(node) && ["stage", "transition", "gate"].includes(node.split(":")[0]!)),
    duplicate: [...have].filter(([, n]) => n > 1).map(([node]) => node),
  };
}

/** What a drill receipt (`seen`) says a node left on the hub, or null where nothing is recorded for that kind of node. */
export type DrillReceipt = {
  scenarioNames?: string[]; result?: string; date?: string;
  seen?: { stages?: Record<string, Record<string, number>>; gates?: Record<string, Record<string, number>>; moves?: Record<string, Record<string, number>> } | null;
};

function seenFor(row: CoverageRow, seen: NonNullable<DrillReceipt["seen"]>): boolean | null {
  if (row.kind === "stage") return Object.entries(seen.stages?.[row.id] ?? {}).some(([state, n]) => n > 0 && !["skipped", "pending"].includes(state));
  if (row.kind === "gate") return (seen.gates?.[row.id]?.passed ?? 0) > 0;
  if (row.kind === "transition") {
    const table = TRANSITION_TABLE.find((item) => transitionId(item) === row.id);
    if (!table || table.from === null) return null;
    return (seen.moves?.[`${table.from}>${table.to === "stay" ? table.from : table.to}`]?.ok ?? 0) > 0;
  }
  return null;
}

/** The «covered live» claims a receipt can speak to, checked against what its run left on the hub. */
export function checkReceipt(rows: readonly CoverageRow[], receipt: DrillReceipt): { checked: number; confirmed: number; notSeen: string[]; skipped: string; evidence: boolean } {
  const ran = new Set(receipt.scenarioNames ?? []);
  if (!receipt.seen) return { checked: 0, confirmed: 0, notSeen: [], skipped: "the receipt records nothing of what the run left on the hub (a drill from before 0.1.269)", evidence: false };
  let checked = 0, confirmed = 0;
  const notSeen: string[] = [];
  for (const row of rows) {
    if (row.status !== "live" || !row.live.some((scenario) => ran.has(scenario))) continue;
    const result = seenFor(row, receipt.seen);
    if (result === null) continue;
    checked += 1;
    if (result) confirmed += 1; else notSeen.push(`${row.kind}:${row.id} (claimed by ${row.live.filter((scenario) => ran.has(scenario)).join(", ")})`);
  }
  return { checked, confirmed, notSeen, skipped: "", evidence: true };
}

/** Term or founder's word (SMA: Graph regression catalogue): a node nobody proves carries a deferral with a term or the owner's word in its note. */
export const untermedGaps = (rows: readonly CoverageRow[]) => rows.filter((row) => row.status === "none" && !/deferral:[A-Za-z0-9_-]+|owner:|владелец/i.test(row.note));

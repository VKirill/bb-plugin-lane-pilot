/**
 * Seeds src/rooms/sma-map/evidence/rNN.ts with what can be derived mechanically and honestly — nothing else:
 *  - reach: seedEntry(...) for nodes whose KIND is an input event itself: a command (the owner types it), a window
 *    door (the owner presses it), a session hook (Claude Code fires it). Needs are left for the batch agent;
 *  - trace: wfRun(<workflow>) for a node whose proof is a whole workflow file (or its "entry"), wfStep(<workflow>,
 *    <node>) for a proof that names a node of that workflow.
 * It never touches a node that already has a line: `npx tsx scripts/sma-seed-evidence.ts [--write]` (dry run prints
 * what it would add). Run once on 2026-11-14; kept so the seed can be audited and re-derived.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { SMA_EVIDENCE } from "../src/rooms/sma-map/evidence";
import { SMA_NODES, SMA_REGIONS } from "../src/rooms/sma-map/graph";

const root = join(import.meta.dirname, "..");
const ENTRY_BY_KIND: Record<string, string> = { command: "the owner runs the command", window_door: "the owner presses the door in the window", hook: "a Claude Code session event fires the hook" };

/** The seeded trace of a workflow proof, as source text, or null. */
function workflowTrace(proof: string | undefined): string | null {
  const hit = proof && /^workflows\/([\w.-]+)\.json(?:#(.*))?$/.exec(proof);
  if (!hit) return null;
  const path = join(root, "workflows", `${hit[1]}.json`);
  if (!existsSync(path)) return null;
  const graph = JSON.parse(readFileSync(path, "utf8")) as { id: string; nodes?: Array<{ id: string }> };
  const anchor = hit[2];
  if (!anchor || anchor === "\"entry\"") return `wfRun(${JSON.stringify(graph.id)})`;
  const node = /^"(?:id": ")?([\w.-]+)"$/.exec(anchor)?.[1];
  if (node && graph.nodes?.some((item) => item.id === node)) return `wfStep(${JSON.stringify(graph.id)}, ${JSON.stringify(node)})`;
  return null;
}

const write = process.argv.includes("--write");
const summary: string[] = [];
SMA_REGIONS.forEach((region, index) => {
  const file = join(root, "src/rooms/sma-map/evidence", `r${String(index).padStart(2, "0")}.ts`);
  const lines: string[] = [];
  const used = new Set<string>();
  for (const [id, regionIndex, , kind] of SMA_NODES) {
    if (regionIndex !== index || SMA_EVIDENCE[id]) continue;
    const parts: string[] = [];
    if (ENTRY_BY_KIND[kind]) { parts.push(`reach: seedEntry(${JSON.stringify(ENTRY_BY_KIND[kind])})`); used.add("seedEntry"); }
    const trace = workflowTrace(SMA_ENTRIES[id]?.[2]);
    if (trace) { parts.push(`trace: ${trace}`); used.add(trace.slice(0, trace.indexOf("("))); }
    if (parts.length) lines.push(`  ${id}: { ${parts.join(", ")} },`);
  }
  summary.push(`${String(index).padStart(2)} ${region}: ${lines.length} seeded`);
  if (!write) return;
  if (existsSync(file) && readFileSync(file, "utf8").includes(": {")) { summary.push(`   ${file} already has lines — not overwritten`); return; }
  lines.sort((a, b) => Number(/n(\d+)/.exec(a)![1]) - Number(/n(\d+)/.exec(b)![1]));
  writeFileSync(file, `// Region ${index} · ${region} — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { ${[...used, "type RegionEvidence"].sort().join(", ")} } from "./types";

export default {
${lines.join("\n")}
} satisfies RegionEvidence;
`);
});
process.stdout.write(`${summary.join("\n")}\n`);

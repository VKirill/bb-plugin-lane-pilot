/**
 * Writes src/rooms/sma-map/hollow-facts.json: the static facts of the hollow detector (sma-parity-tz.md §4а signs 1, 3,
 * 4, 5 and the chain-test waiver of sign 2) read from this checkout — workflow graphs, their defects, the setting keys
 * each map node's function reads, markers and constant answers. The hub has no sources: the CLI reads this file there
 * and combines it with the live signs (2, 6) from the database.
 *   npx tsx scripts/sma-hollow.ts [--check]     (--check exits 1 when the file is stale)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { SMA_NODES } from "../src/rooms/sma-map/graph";
import { collectHollowFacts, type HollowFacts } from "../src/rooms/sma-map/hollow-facts";

const root = join(import.meta.dirname, "..");
const target = join(root, "src/rooms/sma-map/hollow-facts.json");

/** One fact per line, so that a regenerated file diffs and merges by line. */
export function renderFacts(facts: HollowFacts): string {
  const lines = (items: readonly unknown[]) => items.map((item) => JSON.stringify(item)).join(",\n");
  const record = (rec: Readonly<Record<string, unknown>>) => Object.keys(rec).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((key) => `${JSON.stringify(key)}:${JSON.stringify(rec[key])}`).join(",\n");
  return `{"generatedFrom":${JSON.stringify(facts.generatedFrom)},
"graphs":[
${lines(facts.graphs)}
],
"workflowDefects":[
${lines(facts.workflowDefects)}
],
"coverage":{
${record(facts.coverage)}
},
"settingReads":{
${record(facts.settingReads)}
},
"anchors":{
${record(facts.anchors)}
},
"anchorDefects":{
${record(facts.anchorDefects)}
},
"functionDefects":[
${lines(facts.functionDefects)}
]}
`;
}

if (process.argv[1]?.endsWith("sma-hollow.ts")) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim().slice(0, 12);
  const proofs = Object.fromEntries(SMA_NODES.map(([id]) => [id, SMA_ENTRIES[id]?.[2]]));
  const out = renderFacts(collectHollowFacts(root, proofs, head));
  // The header names the commit it was generated on; staleness is about the facts.
  const body = (text: string) => text.slice(text.indexOf("\"graphs\""));
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (body(current) !== body(out)) { process.stderr.write("src/rooms/sma-map/hollow-facts.json is stale: run npx tsx scripts/sma-hollow.ts\n"); process.exit(1); }
    process.stdout.write("hollow-facts.json is current\n");
  } else {
    writeFileSync(target, out);
    const facts = JSON.parse(out) as HollowFacts;
    process.stdout.write(`${facts.graphs.length} graphs, ${facts.workflowDefects.length} workflow defects, ${Object.keys(facts.settingReads).length} nodes reading settings, ${facts.functionDefects.length} function defects -> src/rooms/sma-map/hollow-facts.json\n`);
  }
}

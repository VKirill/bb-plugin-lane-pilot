// Hint list for authors, not a gate: `npx tsx scripts/sma-anchor-check.ts [--region N]` prints every node that has a [sma:<id>] test
// whose proof anchor file is imported (directly or through one hop) by none of its test files, i.e. the test probably does not
// exercise the anchor and a mutation there would "survive". A wrong anchor is fixed in entries.ts, not mutated (docs/sma-evidence.md).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { anchorInfo } from "../src/rooms/sma-map/cli-proofs";
import { SMA_CARDS, SMA_NODES } from "../src/rooms/sma-map/graph";
import { SMA_CONTRACT_TESTS } from "../src/rooms/sma-map/contracts";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { resolveModule } from "../src/rooms/sma-map/symbols";

const root = resolve(join(import.meta.dirname, ".."));
const at = process.argv.indexOf("--region");
const region = at >= 0 ? Number(process.argv[at + 1]) : null;
const IMPORT = /(?:from|import|mock|require)\s*\(?\s*["']([^"']+)["']/g;
const importsOf = (file: string): string[] => {
  if (!existsSync(join(root, file))) return [];
  const found = [...readFileSync(join(root, file), "utf8").matchAll(IMPORT)].map((hit) => resolveModule(root, file, hit[1]!));
  return found.filter((path): path is string => !!path);
};

let listed = 0;
for (const [id, nodeRegion] of SMA_NODES) {
  if (region !== null && nodeRegion !== region) continue;
  const tests = [...new Set((SMA_CONTRACT_TESTS[SMA_CARDS[id]?.[0] ?? id] ?? []).map((line) => line.split(" › ")[0]!))];
  const anchor = anchorInfo(SMA_ENTRIES[id]?.[2], root);
  if (!tests.length || !anchor || !anchor.lines) continue;
  const reached = new Set(tests.flatMap((test) => { const direct = importsOf(test); return [...direct, ...direct.flatMap(importsOf)]; }));
  if (reached.has(anchor.file)) continue;
  listed += 1;
  process.stdout.write(`${id} ${SMA_CARDS[id]![0]}: anchor ${anchor.file}${anchor.symbol ? `#${anchor.symbol}` : ""} is not imported (directly or one hop) by ${tests.join(", ")}\n`);
}
process.stdout.write(`${listed} node(s) listed${region !== null ? ` in region ${region}` : ""}: a hint, not a gate.\n`);

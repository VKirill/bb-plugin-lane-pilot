/**
 * Writes docs/atlas.md, the generated map of Lane Pilot (src/rooms/atlas), and the numbers block of README.md. `npx tsx scripts/generate-atlas.ts [--check]`: --check exits 1
 * when docs/atlas.md was generated from other registries than the code has now (tests/atlas.test.ts runs the same check).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectAtlasInput } from "./atlas-input";
import { atlasHash, renderAtlas, renderReadmeNumbers } from "../src/rooms/atlas";

const root = join(import.meta.dirname, "..");
const input = collectAtlasInput(root);
const target = join(root, "docs/atlas.md");
const readme = join(root, "README.md");
const NUMBERS = /<!-- numbers:start [0-9a-f]+ -->[\s\S]*?<!-- numbers:end -->/;
if (process.argv.includes("--check")) {
  const hash = atlasHash(input);
  const ok = readFileSync(target, "utf8").includes(`<!-- atlas:structure ${hash} -->`) && readFileSync(readme, "utf8").includes(`<!-- numbers:start ${hash} -->`);
  console.log(ok ? "docs/atlas.md and the README numbers match the code" : "docs/atlas.md or the README numbers are stale: run npx tsx scripts/generate-atlas.ts");
  process.exit(ok ? 0 : 1);
}
writeFileSync(target, renderAtlas(input));
const current = readFileSync(readme, "utf8");
if (!NUMBERS.test(current)) throw new Error("README.md has no <!-- numbers:start … --> … <!-- numbers:end --> block");
writeFileSync(readme, current.replace(NUMBERS, renderReadmeNumbers(input)));
console.log(`docs/atlas.md: ${input.rooms.length} rooms, ${input.stages.length} stages, ${input.transitions.length} transitions, ${input.rpc.length} RPC methods`);

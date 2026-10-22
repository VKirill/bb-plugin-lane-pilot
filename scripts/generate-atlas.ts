/**
 * Writes docs/atlas.md, the generated map of Lane Pilot (src/rooms/atlas). `npx tsx scripts/generate-atlas.ts [--check]`: --check exits 1
 * when docs/atlas.md was generated from other registries than the code has now (tests/atlas.test.ts runs the same check).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectAtlasInput } from "./atlas-input";
import { atlasHash, renderAtlas } from "../src/rooms/atlas";

const root = join(import.meta.dirname, "..");
const input = collectAtlasInput(root);
const target = join(root, "docs/atlas.md");
if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  const ok = current.includes(`<!-- atlas:structure ${atlasHash(input)} -->`);
  console.log(ok ? "docs/atlas.md matches the code" : "docs/atlas.md is stale: run npx tsx scripts/generate-atlas.ts");
  process.exit(ok ? 0 : 1);
}
writeFileSync(target, renderAtlas(input));
console.log(`docs/atlas.md: ${input.rooms.length} rooms, ${input.stages.length} stages, ${input.transitions.length} transitions, ${input.rpc.length} RPC methods`);

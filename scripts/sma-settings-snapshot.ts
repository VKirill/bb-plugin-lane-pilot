/**
 * Writes src/rooms/sma-map/unlisted-switches.json from src/rooms/settings/switches.ts (UNLISTED_SWITCHES): sma-map cannot
 * import the settings room (the room graph is a DAG and settings reaches the rooms that import sma-map), so the map
 * reads a copy. `npx tsx scripts/sma-settings-snapshot.ts [--check]`; tests/sma-reach.test.ts fails when the copy is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNLISTED_SWITCHES } from "../src/rooms/settings/switches";

const target = join(import.meta.dirname, "..", "src/rooms/sma-map/unlisted-switches.json");
export const unlistedSnapshot = (): string => `${JSON.stringify(Object.fromEntries(Object.entries(UNLISTED_SWITCHES).map(([key, [, values, what]]) => [key, [values, what]])), null, 1)}\n`;

if (process.argv[1]?.endsWith("sma-settings-snapshot.ts")) {
  const out = unlistedSnapshot();
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== out) { process.stderr.write("src/rooms/sma-map/unlisted-switches.json is stale: run npx tsx scripts/sma-settings-snapshot.ts\n"); process.exit(1); }
  } else writeFileSync(target, out);
}
